import type { Agent } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/memory';
import { runEvals } from '@mastra/core/evals';
import { describe, expect, it, vi } from 'vitest';

import { durablePmAgent } from '../../agents/pm-agent.js';
import { getServerModel } from '../../providers/model.js';
import { PM_EVAL_CASES, type PmEvalReference } from './fixtures.js';
import { buildDurableScoringData, createDurableEvalTarget } from './target.js';
import {
  computePmJudgeScore,
  createPmReferenceScorer,
  evaluatePmHardChecks,
  PM_EVAL_HARD_GATE_THRESHOLD,
  PM_EVAL_SCORE_THRESHOLD,
  buildReferenceJudgePrompt,
  extractAssistantText,
  extractToolInvocationEvidence,
  pmHardGateScorer,
} from './scorer.js';

// vitest.setup.js seeds inert LLM_* defaults before imports, so resolving the
// judge model here is safe under `npm test`; the live runner resolves it for
// real after its own preflight.
const pmReferenceScorer = createPmReferenceScorer(getServerModel());

function referenceWith(
  hardChecks: Partial<PmEvalReference['hardChecks']>,
): PmEvalReference {
  return {
    referenceResponse: 'ok',
    mustInclude: [],
    mustNot: [],
    evaluationMode: 'test',
    hardChecks: {
      requiredPhrases: [],
      forbiddenPhrases: [],
      requiredPatterns: [],
      forbiddenTools: [],
      ...hardChecks,
    },
  };
}

describe('PM Agent eval fixtures', () => {
  it('contains the selected critical paths with inspectable golden references', () => {
    expect(PM_EVAL_CASES.map((item) => item.id)).toEqual([
      'weekly-risk-analysis',
      'competitive-missing-anchor',
      'competitive-too-many-competitors',
    ]);

    for (const item of PM_EVAL_CASES) {
      expect(item.input.trim()).not.toBe('');
      expect(item.criticalPath.trim()).not.toBe('');
      expect(item.reference.referenceResponse.trim()).not.toBe('');
      expect(item.reference.mustInclude.length).toBeGreaterThan(0);
      expect(item.reference.mustNot.length).toBeGreaterThan(0);
      expect(item.reference.hardChecks.requiredPhrases.length).toBeGreaterThan(0);
      expect(item.reference.hardChecks.forbiddenTools.length).toBeGreaterThan(0);
    }
  });

  it('builds a judge prompt with request, golden reference, and actual response', () => {
    const item = PM_EVAL_CASES[0];
    const prompt = buildReferenceJudgePrompt({
      input: item.input,
      groundTruth: item.reference,
      output: 'actual PM response',
    });

    expect(prompt).toContain(item.input);
    expect(prompt).toContain(item.reference.referenceResponse);
    expect(prompt).toContain('actual PM response');
    expect(prompt).toContain('OBSERVED TOOL TRAJECTORY');
    expect(prompt).toContain('must include');
    expect(prompt).toContain('must not');
    // Model-authored text is fenced behind sentinels so an output echoing
    // section headers or embedding instructions stays data for the judge.
    expect(prompt).toContain('BEGIN UNTRUSTED USER REQUEST');
    expect(prompt).toContain('BEGIN UNTRUSTED ACTUAL PM AGENT RESPONSE');
  });

  it('extracts assistant text while ignoring tool messages', () => {
    expect(
      extractAssistantText([
        { role: 'user', content: 'request' },
        { role: 'tool', content: 'tool output' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'second part' },
          ],
        },
      ]),
    ).toBe('first part\nsecond part');
  });

  it('extracts tool invocation evidence for the judge context', () => {
    expect(
      extractToolInvocationEvidence([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'skill',
                state: 'result',
                args: { name: 'weekly-report-analysis' },
                result: 'loaded',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolName: 'skill',
                state: 'result',
                args: { name: 'weekly-report-analysis' },
                result: 'loaded again',
              },
            },
          ],
        },
      ]),
    ).toMatch(/1\. skill.*args=.*weekly-report-analysis.*result=.*loaded.*\n- 2\. skill/);
  });

  it('bounds each evidence args and result value at 512 chars', () => {
    const longValue = 'x'.repeat(600);
    const evidence = extractToolInvocationEvidence([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'search_web',
              state: 'result',
              args: longValue,
              result: longValue,
            },
          },
        ],
      },
    ]);

    expect(evidence).toContain(`args=${'x'.repeat(512)}`);
    expect(evidence).toContain(`result=${'x'.repeat(512)}`);
    expect(evidence).not.toContain('x'.repeat(513));
  });

  it('captures part-level args and results on ai-sdk tool-call and tool-result shapes', () => {
    const evidence = extractToolInvocationEvidence([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search_web', input: { query: 'pm risks' } },
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search_web', output: [{ title: 'Risk report' }] },
        ],
      },
    ]);

    expect(evidence).toContain('search_web');
    expect(evidence).toContain('args=');
    expect(evidence).toContain('pm risks');
    expect(evidence).toContain('result=');
    expect(evidence).toContain('Risk report');
  });

  it('builds scorer messages when durable output has no scoringData', () => {
    const scoringData = buildDurableScoringData('user request', {
      text: 'durable response',
      messages: [],
    });

    expect(scoringData.input.inputMessages[0]).toMatchObject({
      role: 'user',
      content: { format: 2 },
    });
    expect(scoringData.output[0]).toMatchObject({
      role: 'assistant',
      content: { format: 2 },
    });
  });

  it('keeps durable tool evidence and adds final text when messages lack assistant text', () => {
    const scoringData = buildDurableScoringData('user request', {
      text: 'final durable response',
      messages: [
        {
          id: 'tool-message',
          role: 'assistant',
          type: 'text',
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call-1',
                  toolName: 'skill',
                  state: 'result',
                  args: {},
                  result: 'ok',
                },
              },
            ],
          },
        },
      ],
    });

    expect(scoringData.output).toHaveLength(2);
    expect(scoringData.output.at(-1)?.content.parts).toEqual([
      { type: 'text', text: 'final durable response' },
    ]);
  });

  it('appends final text when messages keep only the intro text before a tool call', () => {
    const scoringData = buildDurableScoringData('user request', {
      text: 'final answer with anchor details',
      messages: [
        {
          id: 'intro-tool-message',
          role: 'assistant',
          type: 'text',
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [
              { type: 'text', text: "I'll load the competitive-analysis skill." },
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call-1',
                  toolName: 'skill',
                  state: 'result',
                  args: {},
                  result: 'ok',
                },
              },
            ],
          },
        },
      ],
    });

    expect(scoringData.output).toHaveLength(2);
    expect(extractAssistantText(scoringData.output)).toContain(
      'final answer with anchor details',
    );
  });

  it('drops remembered memory turns from the scoring output', () => {
    const memoryTurn: MastraDBMessage = {
      id: 'remembered-1',
      role: 'assistant',
      type: 'text',
      createdAt: new Date(),
      content: { format: 2, parts: [{ type: 'text', text: 'old turn' }] },
    };
    const responseTurn: MastraDBMessage = {
      id: 'response-1',
      role: 'assistant',
      type: 'text',
      createdAt: new Date(),
      content: { format: 2, parts: [{ type: 'text', text: 'new turn' }] },
    };
    const scoringData = buildDurableScoringData('user request', {
      text: 'new turn',
      messages: [memoryTurn, responseTurn],
      rememberedMessages: [memoryTurn],
    });

    expect(scoringData.output.map((message) => message.id)).toEqual(['response-1']);
  });

  it('adapts durable generate output for runEvals without changing execution target', async () => {
    const generate = vi.spyOn(durablePmAgent, 'generate').mockResolvedValue({
      text: 'durable answer',
      messages: [],
    } as never);

    try {
      const evalTarget = createDurableEvalTarget(
        durablePmAgent as unknown as Agent,
      );
      const output = await evalTarget.generate('eval request') as unknown as {
        scoringData?: { output: Array<{ role: string; content: unknown }> };
      };

      expect(generate).toHaveBeenCalledWith('eval request');
      expect(output.scoringData?.output.at(-1)).toMatchObject({ role: 'assistant' });
    } finally {
      generate.mockRestore();
    }
  });

  it('runs deterministic hard-gate scoring through Mastra runEvals', async () => {
    const productionLikeAgent = {
      id: 'pm-agent',
      name: 'PM Agent',
      getModel: () => ({ specificationVersion: 'v3' }),
      getMastraInstance: () => undefined,
      generate: async () => ({
        text: PM_EVAL_CASES[1].reference.referenceResponse,
        messages: [],
      }),
    } as unknown as Agent;

    const result = await runEvals({
      target: createDurableEvalTarget(productionLikeAgent),
      data: [{
        input: PM_EVAL_CASES[1].input,
        groundTruth: PM_EVAL_CASES[1].reference,
      }],
      scorers: [pmHardGateScorer],
      gates: [pmHardGateScorer],
      concurrency: 1,
    });

    expect(result.verdict).toBe('passed');
    expect(result.scores[pmHardGateScorer.id]).toBe(1);
    expect(result.gateResults?.[0]).toMatchObject({
      id: pmHardGateScorer.id,
      passed: true,
      score: 1,
    });
  });

  it('enforces deterministic hard checks independently of the LLM judge', () => {
    const weekly = PM_EVAL_CASES[0];
    expect(evaluatePmHardChecks(weekly.reference, weekly.reference.referenceResponse)).toEqual({
      passed: true,
      failures: [],
    });
    expect(evaluatePmHardChecks(weekly.reference, 'Risk Rating: 5/10 - WARNING')).toMatchObject({
      passed: false,
    });

    const missingAnchor = PM_EVAL_CASES[1];
    expect(
      evaluatePmHardChecks(
        missingAnchor.reference,
        `${missingAnchor.reference.referenceResponse}\nSaved reportId: pmr_fake`,
      ),
    ).toMatchObject({ passed: false });
    expect(
      evaluatePmHardChecks(
        missingAnchor.reference,
        missingAnchor.reference.referenceResponse,
        '- 1. search_web (result)',
      ),
    ).toMatchObject({ passed: false });
    expect(evaluatePmHardChecks(
      missingAnchor.reference,
      "I can't start the research yet. Name the anchor product first.",
    ).passed,
    ).toBe(true);
    expect(evaluatePmHardChecks(
      missingAnchor.reference,
      'Tell me the anchor product first. No comparison yet.',
    ).passed,
    ).toBe(false);

    const tooManyCompetitors = PM_EVAL_CASES[2];
    expect(
      evaluatePmHardChecks(
        tooManyCompetitors.reference,
        tooManyCompetitors.reference.referenceResponse,
      ),
    ).toEqual({ passed: true, failures: [] });
    expect(evaluatePmHardChecks(
      tooManyCompetitors.reference,
      'The request supplies eight competitors. The set is Notion + 5–7; confirm before research.',
    ).passed,
    ).toBe(true);

    for (const item of PM_EVAL_CASES) {
      expect(
        evaluatePmHardChecks(item.reference, item.reference.referenceResponse),
        item.id,
      ).toEqual({ passed: true, failures: [] });
    }
  });

  it('anchors markdown-heading required phrases to line starts', () => {
    const deeperHeading = evaluatePmHardChecks(
      referenceWith({ requiredPhrases: ['## Summary'] }),
      '### Summary\ncontent',
    );
    expect(deeperHeading.passed).toBe(false);
    expect(deeperHeading.failures).toContain('missing required phrase: ## Summary');
    expect(
      evaluatePmHardChecks(
        referenceWith({ requiredPhrases: ['## Summary'] }),
        'prose first\n\n## Summary\ncontent',
      ).passed,
    ).toBe(true);
  });

  it('fails on a missing required phrase even when nothing else is wrong', () => {
    // Mutation guard: every other `passed: false` expectation in this suite is
    // simultaneously covered by a pattern or a forbidden check, so disabling
    // the required-phrase branch must fail here.
    const result = evaluatePmHardChecks(
      referenceWith({ requiredPhrases: ['## On Track'] }),
      'All good.\n## Summary\nNothing else missing.',
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(['missing required phrase: ## On Track']);
  });

  it('matches forbidden tool names exactly, not by prefix and not inside results', () => {
    const reference = referenceWith({ forbiddenTools: ['search_web'] });
    expect(evaluatePmHardChecks(
      reference,
      'response',
      '- 1. search_web_v2 (result) args={} result=ok',
    ).passed,
    ).toBe(true);
    expect(evaluatePmHardChecks(
      reference,
      'response',
      '- 1. skill (result) args={} result=loaded\n- 2. search_web (result) args={} result=ok',
    ).passed,
    ).toBe(false);
    // A tool RESULT whose payload mentions a forbidden tool name must not
    // trip the invocation check.
    expect(evaluatePmHardChecks(
      reference,
      'response',
      '- 1. skill (result) args={} result=- search_web was used previously',
    ).passed,
    ).toBe(true);
  });

  it('flags forbidden save receipts regardless of casing', () => {
    const result = evaluatePmHardChecks(
      referenceWith({ forbiddenPhrases: ['Saved reportId:'] }),
      'saved reportid: pmr_20260101120000_deadbeef',
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('contains forbidden phrase: Saved reportId:');
  });

  it('rejects a whole-reply code fence but allows inline fences', () => {
    const wrapped = evaluatePmHardChecks(
      referenceWith({ requiredPhrases: ['risk'] }),
      '```markdown\nrisk review\n```',
    );
    expect(wrapped.passed).toBe(false);
    expect(wrapped.failures).toContain('response is wrapped in a code fence');
    expect(evaluatePmHardChecks(
      referenceWith({ requiredPhrases: ['risk'] }),
      'risk review:\n```json\n{"a":1}\n```\ndone',
    ).passed,
    ).toBe(true);
  });

  it('keeps the rating pattern robust to bolding and strict to critical severity', () => {
    const [ratingPattern] = PM_EVAL_CASES[0].reference.hardChecks.requiredPatterns;
    const rating = new RegExp(ratingPattern, 'i');
    expect(rating.test('**Risk Rating: 9/10 - IN-DANGER**')).toBe(true);
    expect(rating.test('Risk Rating: 9/10 - IN-DANGER')).toBe(true);
    expect(rating.test('Risk Rating: 10/10 — IN-DANGER')).toBe(true);
    expect(rating.test('**Risk Rating: 8/10 - IN-DANGER**')).toBe(false);
  });

  it('matches competitor-count, deferral, and anchor-ask phrasings beyond golden wording', () => {
    const [countPattern, , deferPattern] = PM_EVAL_CASES[2].reference.hardChecks.requiredPatterns;
    const count = new RegExp(countPattern, 'i');
    expect(count.test('You listed eight (8) competitors.')).toBe(true);
    expect(count.test('The request includes 8 seed competitors.')).toBe(true);
    expect(count.test('please select at most seven competitors to keep')).toBe(false);
    const defer = new RegExp(deferPattern, 'i');
    expect(defer.test("I can't begin researching until you narrow the list.")).toBe(true);
    expect(defer.test('I cannot begin research until the anchor is named.')).toBe(true);
    expect(defer.test('Only after that will I begin the research.')).toBe(true);

    const [askPattern] = PM_EVAL_CASES[1].reference.hardChecks.requiredPatterns;
    const ask = new RegExp(askPattern, 'i');
    expect(ask.test('Please name the anchor product first. Only after that will I begin the research.')).toBe(true);
    expect(ask.test('Please provide the anchor product and, if you have them, any mandatory competitors.')).toBe(true);
    expect(ask.test('I need at least one named product before starting the competitive analysis.')).toBe(true);
    expect(ask.test('Starting the competitive analysis now.')).toBe(false);
  });

  it('aggregates judge dimensions with clamping and falls back to the holistic score', () => {
    expect(
      computePmJudgeScore({ score: 0.9, correctness: 1, completeness: 0.8, relevance: 1, safety: 1 }),
    ).toBeCloseTo(0.95);
    // A zero safety dimension must pull the aggregate down even when the
    // judge's holistic score is high.
    expect(
      computePmJudgeScore({ score: 0.8, correctness: 1, completeness: 1, relevance: 1, safety: 0 }),
    ).toBe(0.75);
    // Out-of-range judge numbers clamp instead of zeroing the analysis.
    expect(
      computePmJudgeScore({ score: 0, correctness: 1.5, completeness: 0.5, relevance: 1, safety: 1 }),
    ).toBeCloseTo(0.875);
    // Non-finite dimensions fall back to the clamped holistic score.
    expect(
      computePmJudgeScore({ score: 1.2, correctness: Number.NaN, completeness: 1, relevance: 1, safety: 1 }),
    ).toBe(1);
  });

  it('defines one Mastra scorer with score and reason steps', () => {
    expect(pmReferenceScorer.id).toBe('pm-reference-quality');
    expect(pmReferenceScorer.getSteps().map((step) => step.name)).toEqual([
      'analyze',
      'generateScore',
      'generateReason',
    ]);
    expect(pmHardGateScorer.id).toBe('pm-hard-gate');
    expect(pmHardGateScorer.getSteps().map((step) => step.name)).toEqual([
      'generateScore',
      'generateReason',
    ]);
    expect(PM_EVAL_SCORE_THRESHOLD).toBe(0.75);
    expect(PM_EVAL_HARD_GATE_THRESHOLD).toBe(1);
  });
});
