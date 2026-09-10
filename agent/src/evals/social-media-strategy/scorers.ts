import { createScorer } from '@mastra/core/evals';
import type { MastraModelConfig } from '@mastra/core/llm';
import { z } from 'zod';

/**
 * Scorers for the Social Media Strategist eval (critical path: generate
 * strategi konten — brand-strategy mode).
 *
 * (a) `strategy-brief-structure` — deterministic gate, no LLM: the agent
 *     output must contain a non-empty Content Strategy Brief with the
 *     required sections from the agent's own STRATEGY_BRIEF_TEMPLATE.
 * (b) `strategy-vs-golden` — LLM judge comparing the agent output against
 *     the golden reference (`run.groundTruth`) on coverage, scope
 *     alignment, and factual consistency.
 *
 * `runEvals` passes the agent's `scoringData.output` as `run.output`
 * (MastraDBMessage[] for agent targets), so both scorers extract the
 * text defensively from an unknown shape.
 */

export type StrategyJudgeModel = MastraModelConfig;

/**
 * The brief sections every strategy output must carry. Deliberately a
 * stable subset of STRATEGY_BRIEF_TEMPLATE: the agent is instructed to
 * "include only the sections that make sense", so gating on every
 * template section would flake. These five are the load-bearing ones
 * for a request that supplies full brand context.
 */
export const REQUIRED_BRIEF_SECTIONS = [
  '# Content Strategy Brief',
  '## Objective',
  '## Target Audience',
  '## Key Topics',
  '## Deliverables',
] as const;

/** Minimum characters of extracted text for the gate to consider the output substantive. */
export const MIN_BRIEF_OUTPUT_CHARS = 200;

/**
 * Extracts the assistant text from an agent-eval run payload. Handles:
 * - plain strings,
 * - the @mastra/core 1.50.1 `scoringData.output` message shape —
 *   `message.content` is an OBJECT `{ format, parts: [{ type: 'text', text }] }`,
 * - UIMessage-shaped arrays (`message.parts` with `{ type: 'text', text }`),
 * - DB-message-shaped arrays (`message.content` as string or as parts).
 */
export function extractStrategyOutputText(output: unknown): string {
  if (typeof output === 'string') return output.trim();
  if (!Array.isArray(output)) return '';
  const texts: string[] = [];
  for (const message of output) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    const partArrays: unknown[] = [
      (message as { parts?: unknown }).parts,
      content,
      content && typeof content === 'object' && !Array.isArray(content)
        ? (content as { parts?: unknown }).parts
        : undefined,
    ];
    if (typeof content === 'string') texts.push(content);
    for (const carrier of partArrays) {
      if (!Array.isArray(carrier)) continue;
      for (const part of carrier) {
        if (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          texts.push((part as { text: string }).text);
        }
      }
    }
  }
  return texts.join('\n\n').trim();
}

/**
 * Extracts the original user request from an agent-eval run input. The
 * agent scorer input is either a string or an object carrying
 * `inputMessages`/`rememberedMessages` message arrays.
 */
export function extractStrategyRequestText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const carrier = input as { inputMessages?: unknown; rememberedMessages?: unknown };
    const messages = carrier.inputMessages ?? carrier.rememberedMessages;
    const text = extractStrategyOutputText(messages);
    if (text) return text;
  }
  return '(original request unavailable)';
}

export interface BriefStructureCheck {
  present: string[];
  missing: string[];
  substantive: boolean;
}

/** Case-insensitive structural check of the brief text. Pure and unit-testable. */
export function evaluateBriefStructure(text: string): BriefStructureCheck {
  const normalized = text.toLowerCase();
  const present: string[] = [];
  const missing: string[] = [];
  for (const section of REQUIRED_BRIEF_SECTIONS) {
    if (normalized.includes(section.toLowerCase())) present.push(section);
    else missing.push(section);
  }
  return { present, missing, substantive: text.trim().length >= MIN_BRIEF_OUTPUT_CHARS };
}

export function createStrategyBriefStructureScorer() {
  return createScorer({
    id: 'strategy-brief-structure',
    description:
      'Deterministic gate: the strategist output is a substantive Content Strategy Brief containing the required brief sections.',
    type: 'agent',
  })
    .preprocess(({ run }) => extractStrategyOutputText(run.output))
    .generateScore(({ results }) => {
      const text = results.preprocessStepResult;
      const check = evaluateBriefStructure(text);
      return check.substantive && check.missing.length === 0 ? 1 : 0;
    })
    .generateReason(({ results }) => {
      const text = results.preprocessStepResult;
      const check = evaluateBriefStructure(text);
      if (!check.substantive) {
        return `Output too short (${text.trim().length} chars, need >= ${MIN_BRIEF_OUTPUT_CHARS}).`;
      }
      if (check.missing.length > 0) {
        return `Missing brief sections: ${check.missing.join(', ')}.`;
      }
      return 'Brief contains every required section.';
    });
}

const STRATEGY_JUDGE_INSTRUCTIONS = `You are a strict content-strategy evaluator. You compare a strategist's output against a golden reference written for the same request. The golden reference defines expected QUALITY and KEY POINTS, not exact wording — the output must not copy it verbatim, and creative differences in phrasing, ordering, or idea selection are acceptable as long as the strategic substance is covered. Judge only what is present in the documents. Never invent requirements that appear in neither document. Never reward length alone.`;

const strategyJudgeAnalysisSchema = z.object({
  coverage: z
    .number()
    .min(0)
    .max(1)
    .describe('How many of the golden reference key strategic points are meaningfully covered.'),
  scopeAlignment: z
    .number()
    .min(0)
    .max(1)
    .describe('How well the output honors the request explicit scope (period, idea count, platforms, cadence, deliverables).'),
  factualConsistency: z
    .number()
    .min(0)
    .max(1)
    .describe('How consistent every brand fact in the output is with the original request (no fabricated features, claims, or brand facts).'),
  missingPoints: z
    .array(z.string())
    .describe('Key golden-reference points the output fails to cover; empty when none.'),
});

/** Weights for the weighted score. Sum = 1. */
export const STRATEGY_JUDGE_WEIGHTS = { coverage: 0.5, scopeAlignment: 0.3, factualConsistency: 0.2 } as const;

export function computeStrategyJudgeScore(analysis: {
  coverage: number;
  scopeAlignment: number;
  factualConsistency: number;
}): number {
  const { coverage, scopeAlignment, factualConsistency } = analysis;
  return Math.max(
    0,
    Math.min(
      1,
      STRATEGY_JUDGE_WEIGHTS.coverage * coverage +
        STRATEGY_JUDGE_WEIGHTS.scopeAlignment * scopeAlignment +
        STRATEGY_JUDGE_WEIGHTS.factualConsistency * factualConsistency,
    ),
  );
}

export function createStrategyVsGoldenScorer(judgeModel: StrategyJudgeModel) {
  return createScorer({
    id: 'strategy-vs-golden',
    description:
      'LLM judge comparing the strategist output against the golden reference on coverage, scope alignment, and factual consistency.',
    type: 'agent',
    judge: {
      model: judgeModel,
      instructions: STRATEGY_JUDGE_INSTRUCTIONS,
    },
  })
    .analyze({
      description: 'Compare the strategy output against the golden reference',
      outputSchema: strategyJudgeAnalysisSchema,
      createPrompt: ({ run }) => {
        const requestText = extractStrategyRequestText(run.input);
        const outputText = extractStrategyOutputText(run.output);
        const goldenText = typeof run.groundTruth === 'string' ? run.groundTruth : String(run.groundTruth ?? '');
        return `Compare the strategist output against the golden reference for the same content-strategy request.

## Original request
${requestText}

## Golden reference (defines expected quality and key points)
${goldenText}

## Strategist output to evaluate
${outputText}

Score each dimension from 0 to 1 (decimals allowed, be calibrated — do not default to 1):

- coverage: which of the golden reference's key strategic points (objective framing, audience definition, topic/theme choices, content ideas with platform and format, cadence, success framing) does the output meaningfully cover? An equivalent reformulation counts; a missing whole area (for example: no content ideas at all, or ideas without platform/format) does not.
- scopeAlignment: does the output honor the original request's explicit scope — time period, number of content ideas, requested platforms, cadence, and deliverables? Wrong counts, wrong platforms, or ignored deliverables lower this score.
- factualConsistency: is every brand fact in the output (brand name, product features, audience, tone constraints) consistent with the original request? Fabricated features, invented brand claims, or contradicting the requested tone lower this score.

Also return missingPoints: short strings naming the key golden-reference points the output fails to cover (empty list when nothing material is missing).`;
      },
    })
    .generateScore(({ results }) => computeStrategyJudgeScore(results.analyzeStepResult))
    .generateReason(({ results, score }) => {
      const { coverage, scopeAlignment, factualConsistency, missingPoints } = results.analyzeStepResult;
      const missing =
        missingPoints.length > 0 ? ` Missing golden points: ${missingPoints.join('; ')}.` : ' No material golden points missing.';
      return (
        `Score ${score.toFixed(2)} — coverage ${coverage.toFixed(2)}, scope alignment ${scopeAlignment.toFixed(2)}, ` +
        `factual consistency ${factualConsistency.toFixed(2)}.${missing}`
      );
    });
}
