import { randomUUID } from 'node:crypto';

import { runEvals } from '@mastra/core/evals';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { expect, it } from 'vitest';

import { env } from '../../config/env.js';
import { PM_EVAL_CASES } from './fixtures.js';
import { PM_EVAL_HARD_GATE_THRESHOLD, PM_EVAL_SCORE_THRESHOLD } from './scorer.js';

function assertLlmConfigured(): void {
  const missing = (['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_DEFAULT_MODEL'] as const).filter(
    (key) => !env[key].trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `The PM eval needs a live model gateway. Missing in agent/.env: ${missing.join(', ')}. ` +
        'Set them (LLM_BASE_URL, LLM_API_KEY, LLM_DEFAULT_MODEL) and re-run npm run eval:pm.',
    );
  }
}

type PmEvalResult = {
  id: string;
  llmScore: number;
  hardGateScore: number;
  reason: string;
};

const evaluationData = PM_EVAL_CASES.map((item) => ({
  input: item.input,
  groundTruth: {
    ...item.reference,
    caseId: item.id,
  },
}));

function report(line = ''): void {
  // Vitest hides console output for passing tests; write the eval report
  // directly so `npm run eval:pm` always shows scores in the terminal.
  process.stdout.write(`${line}\n`);
}

it('scores PM Agent critical paths against golden references', async () => {
  assertLlmConfigured();

  // Keep the model-resolving imports after the preflight: importing the PM
  // agent module constructs the production DurableAgent, whose constructor
  // eagerly resolves the model, so an env-less machine must hit the
  // actionable message above — never an import-time crash.
  const [
    { durablePmAgent },
    { OpenAICompatibleGateway },
    { createDurableEvalTarget },
    { createPmReferenceScorer, pmHardGateScorer },
    { getServerModel },
  ] = await Promise.all([
    import('../../agents/pm-agent.js'),
    import('../../mastra/gateways/openai-compatible.js'),
    import('./target.js'),
    import('./scorer.js'),
    import('../../providers/model.js'),
  ]);

  const pmReferenceScorer = createPmReferenceScorer(getServerModel());

  // Register the same durable PM Agent used by production against an eval-only
  // runtime, never the production Postgres runtime.
  const evalStorage = new InMemoryStore({ id: 'pm-agent-evals' });
  const evalMastra = new Mastra({
    agents: { pmAgent: durablePmAgent },
    storage: evalStorage,
    gateways: { openAICompatible: new OpenAICompatibleGateway() },
  });
  evalMastra.addScorer(pmReferenceScorer);
  evalMastra.addScorer(pmHardGateScorer);

  const memory = await durablePmAgent.getMemory();
  memory?.setStorage(evalStorage);

  // DurableAgent in the pinned Mastra version returns FullOutput without the
  // scorer payload that runEvals expects. The adapter delegates to the
  // production durable instance, then reconstructs that payload from its
  // returned messages so the eval still exercises the production path.
  const evalTarget = createDurableEvalTarget(
    durablePmAgent as unknown as Agent<string, ToolsInput, undefined, unknown>,
  );

  const caseResults: PmEvalResult[] = [];

  report('\nPM Agent Evaluation');
  report('Scorers: pm-reference-quality + pm-hard-gate');
  report(`LLM advisory threshold: ${PM_EVAL_SCORE_THRESHOLD.toFixed(2)}`);
  report(`Hard-gate threshold: ${PM_EVAL_HARD_GATE_THRESHOLD.toFixed(2)}`);

  const scores: number[] = [];
  for (const [index, item] of evaluationData.entries()) {
    const result = await runEvals({
      target: evalTarget,
      data: [item],
      scorers: [pmReferenceScorer, pmHardGateScorer],
      gates: [pmHardGateScorer],
      targetOptions: {
        // PM's task signals require an active Memory scope. A fresh scope per
        // case, in the canonical {agentId}-{resourceId}-{uuid} thread shape
        // under the reserved `evals` resource, prevents conversation history
        // from leaking between fixtures and keeps the eval out of every user
        // thread listing.
        memory: {
          thread: `pm-agent-evals-${randomUUID()}`,
          resource: 'evals',
        },
        // Skill activation is part of the PM routing path. Keep research and
        // persistence tools disabled so this suite needs only the model gateway.
        activeTools: ['skill'],
        maxSteps: 4,
        modelSettings: { temperature: 0 },
      },
      concurrency: 1,
      onItemComplete: ({ item: completedItem, scorerResults }) => {
        const reference = completedItem.groundTruth as { caseId: string };
        const llmScoreResult = scorerResults[pmReferenceScorer.id] as {
          score?: number;
          reason?: string;
        };
        const hardGateScoreResult = scorerResults[pmHardGateScorer.id] as {
          score?: number;
          reason?: string;
        };
        caseResults.push({
          id: reference.caseId,
          llmScore: llmScoreResult.score ?? 0,
          hardGateScore: hardGateScoreResult.score ?? 0,
          reason: [
            llmScoreResult.reason ?? 'No judge reason returned.',
            `Hard gate: ${hardGateScoreResult.reason ?? 'No hard-gate reason returned.'}`,
          ].join(' '),
        });
      },
    });
    scores.push(result.scores[pmReferenceScorer.id] ?? 0);
  }

  for (const caseResult of caseResults) {
    const passed = caseResult.hardGateScore >= PM_EVAL_HARD_GATE_THRESHOLD;
    const llmAdvisoryPassed = caseResult.llmScore >= PM_EVAL_SCORE_THRESHOLD;
    report(`\n[${passed ? 'PASS' : 'FAIL'}] ${caseResult.id}`);
    report(`LLM judge score: ${caseResult.llmScore.toFixed(2)} (${llmAdvisoryPassed ? 'advisory pass' : 'advisory warning'})`);
    report(`Hard gate score: ${caseResult.hardGateScore.toFixed(2)}`);
    report(`Reason: ${caseResult.reason}`);
  }

  const overallScore = scores.length > 0
    ? scores.reduce((total, score) => total + score, 0) / scores.length
    : 0;
  const passedCount = caseResults.filter(
    (caseResult) => caseResult.hardGateScore >= PM_EVAL_HARD_GATE_THRESHOLD,
  ).length;
  report(`\nOverall score: ${overallScore.toFixed(2)}`);
  report(`Passed: ${passedCount}/${PM_EVAL_CASES.length}`);
  report(`Verdict: ${passedCount === PM_EVAL_CASES.length ? 'passed' : 'failed'}`);

  expect(caseResults).toHaveLength(PM_EVAL_CASES.length);
  expect(caseResults.every(
    (caseResult) => caseResult.hardGateScore >= PM_EVAL_HARD_GATE_THRESHOLD,
  )).toBe(true);
}, 10 * 60 * 1000);
