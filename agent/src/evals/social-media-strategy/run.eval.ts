/**
 * Eval pipeline for the Social Media Strategist's critical path
 * ("generate strategi konten" — brand-strategy mode), per reference/N11_2.md.
 *
 * Runs ON DEMAND — never in `npm test`, `npm run check`, or CI:
 *   npm run eval:social-strategy
 * (vitest with vitest.eval.config.ts; `.eval.ts` files are outside the main
 * vitest config's include patterns, same on-demand posture as `test:e2e`.)
 *
 * What it does:
 *  1. Fails fast when no live LLM is configured (agent/.env LLM_*).
 *  2. Registers the plain strategist agent on a lightweight eval Mastra
 *     instance: gateway wired, in-memory storage (process-local — nothing
 *     outlives the eval), and the two scorers registered so score saves
 *     resolve instead of warning.
 *  3. Runs each dataset case through runEvals with its OWN fresh memory
 *     thread (engine-path runs — like the production durable call sites —
 *     require an active thread for the task-state signal processor, and a
 *     shared thread would leak one case's brief into the next case's
 *     context). The deterministic brief-structure gate must pass; the
 *     LLM-judge strategy-vs-golden scorer is tracked against a lenient
 *     threshold (golden references were authored by a SOTA model; the
 *     pipeline runs a medium model — an acceptable, not perfect, score is
 *     the bar).
 *  4. Prints per-case scores + judge reasons, then aggregate averages,
 *     gate/threshold outcomes, and a final verdict; fails the run ONLY
 *     when a gate fails (structural regression).
 */

import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { runEvals } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';

import { env } from '../../config/env.js';
import { SOCIAL_MEDIA_STRATEGIST_AGENT_ID, socialMediaStrategistAgent } from '../../agents/social-media-strategist-agent.js';
import { OpenAICompatibleGateway } from '../../mastra/gateways/openai-compatible.js';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  stripOpenAICompatibleRouterId,
} from '../../mastra/gateways/openai-compatible-model.js';
import { getServerModel } from '../../providers/model.js';
import { SOCIAL_STRATEGY_EVAL_CASES, type SocialStrategyEvalCase } from './cases.js';
import {
  createStrategyBriefStructureScorer,
  createStrategyVsGoldenScorer,
} from './scorers.js';

/** Lenient on purpose (see file header). Not a pass/fail gate — informational. */
export const STRATEGY_VS_GOLDEN_THRESHOLD = 0.6;

/** Reserved memory resource for eval runs — never a real user's resourceId, so eval threads can never surface in any user's listing. */
const EVAL_RESOURCE_ID = 'evals';

type EvalRunResult = Awaited<ReturnType<typeof runEvals>>;

function assertLlmConfigured(): void {
  const missing = (['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_DEFAULT_MODEL'] as const).filter(
    (key) => !env[key].trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `The social-media-strategy eval needs a live model gateway. Missing in agent/.env: ${missing.join(', ')}. ` +
        'Set them (LLM_BASE_URL, LLM_API_KEY, LLM_DEFAULT_MODEL) and re-run npm run eval:social-strategy.',
    );
  }
}

/** Builds the judge model through the production gateway transport (same base URL, key, and vLLM system-message normalization). */
async function buildJudgeModel() {
  const gateway = new OpenAICompatibleGateway();
  return gateway.resolveLanguageModel({
    modelId: stripOpenAICompatibleRouterId(getServerModel()),
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    apiKey: env.LLM_API_KEY.trim(),
  });
}

/** Fresh memory thread per case, canonical `{agentId}-{resourceId}-{uuid}` shape, under the reserved eval resource. */
function createEvalMemoryOptions(): { memory: { thread: string; resource: string } } {
  return {
    memory: {
      thread: `${SOCIAL_MEDIA_STRATEGIST_AGENT_ID}-${EVAL_RESOURCE_ID}-${randomUUID()}`,
      resource: EVAL_RESOURCE_ID,
    },
  };
}

function formatScoreEntry(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(2) : String(value);
}

function printCaseReport(evalCase: SocialStrategyEvalCase, scorerResults: Record<string, { score?: unknown; reason?: unknown }>): void {
  console.log(`\n[case ${evalCase.id}]`);
  for (const [scorerId, result] of Object.entries(scorerResults)) {
    const score = formatScoreEntry(result?.score);
    const reason = typeof result?.reason === 'string' ? result.reason : '';
    console.log(`  ${scorerId}: ${score}${reason ? ` — ${reason}` : ''}`);
  }
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function printSummaryReport(
  caseResults: { evalCase: SocialStrategyEvalCase; result: EvalRunResult }[],
): void {
  const gateScoreById = new Map<string, number[]>();
  const scorerScoresById = new Map<string, number[]>();
  for (const { result } of caseResults) {
    for (const gate of result.gateResults ?? []) {
      gateScoreById.set(gate.id, [...(gateScoreById.get(gate.id) ?? []), gate.score]);
    }
    for (const threshold of result.thresholdResults ?? []) {
      scorerScoresById.set(threshold.id, [...(scorerScoresById.get(threshold.id) ?? []), threshold.averageScore]);
    }
    for (const [scorerId, score] of Object.entries(result.scores)) {
      if (typeof score === 'number') {
        scorerScoresById.set(scorerId, [...(scorerScoresById.get(scorerId) ?? []), score]);
      }
    }
  }

  let allGatesPassed = true;
  let allThresholdsPassed = true;

  console.log('\n──────────────────────────────────────────────');
  console.log('Social Media Strategist eval — summary');
  console.log(`Cases evaluated: ${caseResults.length}/${SOCIAL_STRATEGY_EVAL_CASES.length}`);
  for (const [gateId, scores] of gateScoreById) {
    const avg = average(scores);
    const passed = avg >= 1 && scores.every((score) => score >= 1);
    if (!passed) allGatesPassed = false;
    console.log(`  gate ${gateId}: ${avg.toFixed(2)} [${passed ? 'PASS' : 'FAIL'}]`);
  }
  for (const [scorerId, scores] of scorerScoresById) {
    const avg = average(scores);
    // Gate scorers are already reported above; every other tracked scorer is threshold-tracked.
    const isThresholdTracked = !gateScoreById.has(scorerId);
    const passed = avg >= STRATEGY_VS_GOLDEN_THRESHOLD;
    if (isThresholdTracked && !passed) allThresholdsPassed = false;
    console.log(`  avg ${scorerId}: ${avg.toFixed(2)}${isThresholdTracked ? ` (threshold ${STRATEGY_VS_GOLDEN_THRESHOLD.toFixed(2)}) [${passed ? 'PASS' : 'MISS'}]` : ''}`);
  }
  const verdict = !allGatesPassed ? 'failed' : allThresholdsPassed ? 'passed' : 'scored';
  console.log(`VERDICT: ${verdict}`);
  console.log('──────────────────────────────────────────────');
}

describe('eval: social-media-strategist — generate strategi konten (critical path)', () => {
  it(
    'scores the strategist brief against the golden references',
    async () => {
      assertLlmConfigured();

      const judgeModel = await buildJudgeModel();
      const strategyBriefStructureScorer = createStrategyBriefStructureScorer();
      const strategyVsGoldenScorer = createStrategyVsGoldenScorer(judgeModel);

      const evalMastra = new Mastra({
        agents: { socialMediaStrategistAgent },
        gateways: { openAICompatible: new OpenAICompatibleGateway() },
        storage: new InMemoryStore({ id: 'social-strategy-eval-storage' }),
        // Registered so runEvals' score persistence resolves these ids
        // (saves land in the in-memory store and die with the process).
        scorers: {
          strategyBriefStructure: strategyBriefStructureScorer,
          strategyVsGolden: strategyVsGoldenScorer,
        },
      });
      const target = evalMastra.getAgent('socialMediaStrategistAgent');
      if (!target) {
        throw new Error('Eval Mastra failed to register the social media strategist agent.');
      }

      console.log(
        `Running ${SOCIAL_STRATEGY_EVAL_CASES.length} eval cases against social-media-strategist-agent ` +
          `(judge model: ${env.LLM_DEFAULT_MODEL})...`,
      );

      const caseResults: { evalCase: SocialStrategyEvalCase; result: EvalRunResult }[] = [];
      for (const evalCase of SOCIAL_STRATEGY_EVAL_CASES) {
        const result = await runEvals({
          target,
          data: [{ input: evalCase.input, groundTruth: evalCase.groundTruth }],
          gates: [strategyBriefStructureScorer],
          scorers: [{ scorer: strategyVsGoldenScorer, threshold: STRATEGY_VS_GOLDEN_THRESHOLD }],
          // Fresh memory thread per case: engine-path runs require an active
          // thread (task-state signal processor), and a shared thread would
          // leak the previous case's brief into this case's context.
          targetOptions: createEvalMemoryOptions(),
          concurrency: 1,
          onItemComplete: ({ scorerResults }) => printCaseReport(evalCase, scorerResults),
        });
        caseResults.push({ evalCase, result });
      }

      printSummaryReport(caseResults);

      const evaluated = caseResults.filter(({ result }) => result.summary.totalItems > 0);
      if (evaluated.length !== SOCIAL_STRATEGY_EVAL_CASES.length) {
        throw new Error(
          `Eval ran ${evaluated.length} of ${SOCIAL_STRATEGY_EVAL_CASES.length} cases — check the runner output above for failures.`,
        );
      }

      // Gate failure = structural regression (no valid brief) → fail the run.
      // A missed quality threshold keeps the run green (verdict 'scored') —
      // scores above are the report; per N11_2 we do not chase perfect scores.
      const gateFailed = caseResults.some(({ result }) => result.verdict === 'failed');
      if (gateFailed) {
        throw new Error(
          'Eval gate failed: the strategist output no longer satisfies the Content Strategy Brief structure. See the per-case report above.',
        );
      }
    },
    900_000,
  );
});
