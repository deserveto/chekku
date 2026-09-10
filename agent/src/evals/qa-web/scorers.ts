import {
  createScorer,
  extractTrajectory,
  type ToolCallStep,
  type Trajectory,
} from '@mastra/core/evals';
import type { MastraModelConfig } from '@mastra/core/llm';
import { z } from 'zod';

import { QA_WEB_FIXTURE_FACTS } from './cases.js';

export type QaJudgeModel = MastraModelConfig;

export const REQUIRED_QA_REPORT_SECTIONS = [
  '# QA Web Smoke Test Report',
  '## Summary',
  '## Checks',
  '## Evidence',
  '## Blockers',
] as const;

export const REQUIRED_QA_BROWSER_TOOLS = ['browser_goto', 'browser_snapshot', 'browser_click'] as const;

const REQUIRED_QA_BROWSER_SEQUENCE = [
  'browser_goto',
  'browser_snapshot',
  'browser_click',
  'browser_snapshot',
] as const;

const UNSAFE_QA_BROWSER_TOOLS = new Set([
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_dialog',
  'browser_drag',
  'browser_evaluate',
]);

export const MIN_QA_REPORT_OUTPUT_CHARS = 180;

interface MessageRecord {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
}

function extractMessageText(message: MessageRecord): string {
  const content = message.content;
  const texts: string[] = [];
  const carriers: unknown[] = [
    message.parts,
    content,
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as { parts?: unknown }).parts
      : undefined,
  ];

  if (typeof content === 'string') texts.push(content);
  for (const carrier of carriers) {
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
  return texts.join('\n\n').trim();
}

function extractMessageArrayText(output: unknown, preferredRole?: string): string {
  if (!Array.isArray(output)) return '';
  const messages = output.filter(
    (message): message is MessageRecord => Boolean(message) && typeof message === 'object',
  );
  const preferred = preferredRole
    ? messages.filter((message) => message.role === preferredRole)
    : messages.filter((message) => message.role === 'assistant');
  const selected = preferredRole || preferred.length > 0 ? preferred : messages;
  return selected
    .map(extractMessageText)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * Extracts report text from the message formats emitted by @mastra/core 1.50.1.
 * The eval scorers intentionally tolerate both DB-message and UI-message parts.
 */
export function extractQaOutputText(output: unknown): string {
  if (typeof output === 'string') return output.trim();
  return extractMessageArrayText(output);
}

/**
 * Mastra 1.50.1's built-in `extractTrajectory` reads `content.parts`, while
 * the agent result used by `runEvals` can expose the same UI parts at the
 * message root. Normalize that shape before delegating to Mastra so the live
 * gate and direct scorer tests inspect the same tool calls.
 */
export function extractQaTrajectory(output: unknown): Trajectory {
  if (!Array.isArray(output)) return { steps: [] };

  const normalized = output.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const record = message as MessageRecord;
    const topLevelParts = record.parts;
    const content = record.content;

    if (Array.isArray(topLevelParts)) {
      const normalizedContent =
        content && typeof content === 'object' && !Array.isArray(content)
          ? { ...(content as Record<string, unknown>), parts: topLevelParts }
          : { format: 2, parts: topLevelParts };
      return { ...record, content: normalizedContent };
    }

    if (Array.isArray(content)) {
      return { ...record, content: { format: 2, parts: content } };
    }

    return message;
  });

  return extractTrajectory(normalized as Parameters<typeof extractTrajectory>[0]);
}

export function extractQaRequestText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return extractMessageArrayText(input, 'user') || extractMessageArrayText(input);
  if (input && typeof input === 'object') {
    const typedInput = input as { inputMessages?: unknown; rememberedMessages?: unknown };
    const messages = typedInput.inputMessages ?? typedInput.rememberedMessages;
    const text = extractMessageArrayText(messages, 'user') || extractMessageArrayText(messages);
    if (text) return text;
  }
  return '(original request unavailable)';
}

export function extractQaRequestOrigin(input: unknown): string | undefined {
  const request = extractQaRequestText(input);
  const match = request.match(/https?:\/\/[^\s/]+/u);
  if (!match) return undefined;
  try {
    return new URL(match[0]).origin;
  } catch {
    return undefined;
  }
}

export interface QaReportStructureCheck {
  present: string[];
  missing: string[];
  substantive: boolean;
  summarySubstantive: boolean;
  checksSubstantive: boolean;
  evidenceSubstantive: boolean;
  blockersSubstantive: boolean;
  missingChecks: string[];
}

function sectionBody(text: string, heading: string): string {
  const lines = text.split(/\r?\n/u);
  const normalizedHeading = heading.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === normalizedHeading);
  if (start < 0) return '';

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/u.test(trimmed)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function hasMeaningfulBody(body: string, options: { allowNone?: boolean } = {}): boolean {
  const normalized = body.replace(/[^\p{L}\p{N}/]+/gu, '').toLowerCase();
  if (normalized === 'none' || normalized === 'n/a' || normalized === 'na') {
    return options.allowNone === true && normalized === 'none';
  }

  const contentCharacters = body.match(/[\p{L}\p{N}]/gu) ?? [];
  return contentCharacters.length >= 3;
}

const REQUIRED_QA_CHECKS = [
  { id: 'page load', pattern: /(?:page|halaman).*(?:load|open|buka|terbuka)/iu },
  { id: 'page title', pattern: /(?:page\s+)?title|judul(?:\s+halaman)?/iu },
  { id: 'main heading', pattern: /(?:main\s+)?heading|heading\s+utama|judul\s+utama/iu },
  { id: 'status', pattern: /status|ready\s+for\s+testing/iu },
  { id: 'pricing navigation', pattern: /pricing|harga|tautan.*pricing/iu },
] as const;

function findCheckRows(body: string): { missingChecks: string[] } {
  const rows = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const usedRows = new Set<number>();
  const missingChecks: string[] = [];

  for (const { id, pattern } of REQUIRED_QA_CHECKS) {
    const rowIndex = rows.findIndex(
      (row, index) =>
        !usedRows.has(index) &&
        /\b(?:PASS|FAIL)\b/iu.test(row) &&
        pattern.test(row),
    );
    if (rowIndex < 0) {
      missingChecks.push(id);
    } else {
      usedRows.add(rowIndex);
    }
  }

  return { missingChecks };
}

/** Strict heading and substantive-section checks for the final QA report. */
export function evaluateQaReportStructure(text: string): QaReportStructureCheck {
  const lines = new Set(text.split(/\r?\n/u).map((line) => line.trim().toLowerCase()));
  const present: string[] = [];
  const missing: string[] = [];
  for (const section of REQUIRED_QA_REPORT_SECTIONS) {
    if (lines.has(section.toLowerCase())) present.push(section);
    else missing.push(section);
  }

  const checksBody = sectionBody(text, '## Checks');
  const { missingChecks } = findCheckRows(checksBody);

  return {
    present,
    missing,
    substantive: text.trim().length >= MIN_QA_REPORT_OUTPUT_CHARS,
    summarySubstantive: hasMeaningfulBody(sectionBody(text, '## Summary')),
    checksSubstantive: hasMeaningfulBody(checksBody) && missingChecks.length === 0,
    evidenceSubstantive: hasMeaningfulBody(sectionBody(text, '## Evidence')),
    blockersSubstantive: hasMeaningfulBody(sectionBody(text, '## Blockers'), { allowNone: true }),
    missingChecks,
  };
}

export interface QaTrajectoryCheck {
  passed: boolean;
  missing: string[];
  failed: string[];
  unsafe: string[];
  scopeViolations: string[];
  ordered: boolean;
}

export interface QaTrajectoryOptions {
  expectedOrigin?: string;
}

function toolCallSucceeded(step: ToolCallStep): boolean {
  if (step.success !== true) return false;
  const result = step.toolResult;
  if (!result) return true;
  return result.success !== false && result.isError !== true && typeof result.error !== 'string';
}

/** Requires the browser actions that prove the read-only smoke test ran. */
export function evaluateQaTrajectory(
  trajectory: Trajectory,
  options: QaTrajectoryOptions = {},
): QaTrajectoryCheck {
  const toolSteps = trajectory.steps.filter(
    (step): step is ToolCallStep => step.stepType === 'tool_call',
  );
  const missing: string[] = [];
  const failed: string[] = [];

  for (const toolName of REQUIRED_QA_BROWSER_TOOLS) {
    const matchingSteps = toolSteps.filter((step) => step.name === toolName);
    if (matchingSteps.length === 0) {
      missing.push(toolName);
      continue;
    }
    if (!matchingSteps.some(toolCallSucceeded)) failed.push(toolName);
  }

  let cursor = -1;
  let ordered = true;
  for (const toolName of REQUIRED_QA_BROWSER_SEQUENCE) {
    const nextIndex = toolSteps.findIndex(
      (step, index) => index > cursor && step.name === toolName && toolCallSucceeded(step),
    );
    if (nextIndex < 0) {
      ordered = false;
      break;
    }
    cursor = nextIndex;
  }

  const unsafe = [...new Set(toolSteps.filter((step) => UNSAFE_QA_BROWSER_TOOLS.has(step.name)).map((step) => step.name))];
  const scopeViolations: string[] = [];
  if (options.expectedOrigin) {
    const addUrlViolation = (step: ToolCallStep, url: string | undefined): void => {
      if (!url) return;
      try {
        if (new URL(url).origin !== options.expectedOrigin) scopeViolations.push(step.name);
      } catch {
        scopeViolations.push(step.name);
      }
    };
    for (const step of toolSteps) {
      const toolUrl = typeof step.toolArgs?.url === 'string' ? step.toolArgs.url : undefined;
      const resultUrl = typeof step.toolResult?.url === 'string' ? step.toolResult.url : undefined;
      addUrlViolation(step, toolUrl);
      addUrlViolation(step, resultUrl);
    }

    const gotoStep = toolSteps.find((step) => step.name === 'browser_goto');
    const gotoUrl = typeof gotoStep?.toolArgs?.url === 'string' ? gotoStep.toolArgs.url : undefined;
    if (gotoStep && !gotoUrl) scopeViolations.push('browser_goto:missing-url');
    if (gotoUrl) {
      try {
        if (!['/', '/index.html'].includes(new URL(gotoUrl).pathname)) scopeViolations.push('browser_goto:path');
      } catch {
        scopeViolations.push('browser_goto:path');
      }
    }

    const clickIndex = toolSteps.findIndex((step) => step.name === 'browser_click');
    const clickStep = clickIndex >= 0 ? toolSteps[clickIndex] : undefined;
    const clickUrl = typeof clickStep?.toolResult?.url === 'string' ? clickStep.toolResult.url : undefined;
    if (clickStep && !clickUrl) scopeViolations.push('browser_click:missing-url');
    if (clickUrl) {
      try {
        if (new URL(clickUrl).pathname !== '/pricing') scopeViolations.push('browser_click:path');
      } catch {
        scopeViolations.push('browser_click:path');
      }
    }

    const postClickSnapshot =
      clickIndex >= 0
        ? toolSteps.slice(clickIndex + 1).find((step) => step.name === 'browser_snapshot')
        : undefined;
    const postClickUrl =
      typeof postClickSnapshot?.toolResult?.url === 'string' ? postClickSnapshot.toolResult.url : undefined;
    if (postClickSnapshot && !postClickUrl) scopeViolations.push('browser_snapshot:missing-url');
    if (postClickUrl) {
      try {
        if (new URL(postClickUrl).pathname !== '/pricing') scopeViolations.push('browser_snapshot:path');
      } catch {
        scopeViolations.push('browser_snapshot:path');
      }
    }
  }

  const uniqueScopeViolations = [...new Set(scopeViolations)];
  return {
    passed:
      missing.length === 0 &&
      failed.length === 0 &&
      unsafe.length === 0 &&
      uniqueScopeViolations.length === 0 &&
      ordered,
    missing,
    failed,
    unsafe,
    scopeViolations: uniqueScopeViolations,
    ordered,
  };
}

export function createQaReportStructureScorer() {
  return createScorer({
    id: 'qa-report-structure',
    description:
      'Deterministic gate: the QA Web Agent output is a substantive smoke-test report with the required evidence sections.',
    type: 'agent',
  })
    .preprocess(({ run }) => extractQaOutputText(run.output))
    .generateScore(({ results }) => {
      const check = evaluateQaReportStructure(results.preprocessStepResult);
      return check.missing.length === 0 &&
        check.substantive &&
        check.summarySubstantive &&
        check.checksSubstantive &&
        check.evidenceSubstantive &&
        check.blockersSubstantive
        ? 1
        : 0;
    })
    .generateReason(({ results }) => {
      const text = results.preprocessStepResult;
      const check = evaluateQaReportStructure(text);
      if (!check.substantive) {
        return `Output too short (${text.trim().length} chars, need >= ${MIN_QA_REPORT_OUTPUT_CHARS}).`;
      }
      if (check.missing.length > 0) return `Missing report sections: ${check.missing.join(', ')}.`;
      if (!check.summarySubstantive) return 'Summary section is empty or non-substantive.';
      if (!check.checksSubstantive) {
        return `Checks section is incomplete. Missing: ${check.missingChecks.join(', ') || 'PASS/FAIL results'}.`;
      }
      if (!check.evidenceSubstantive) return 'Evidence section is empty or non-substantive.';
      if (!check.blockersSubstantive) return 'Blockers section is empty.';
      return 'QA report contains every required substantive section.';
    });
}
export function createQaTrajectoryScorer() {
  return createScorer({
    id: 'qa-browser-trajectory',
    description:
      'Deterministic gate: the agent successfully navigated, inspected, and clicked through the QA fixture.',
    // Mastra 1.50.1 runs `gates` with the raw agent output. Extracting here
    // keeps this scorer safe in both the gate and regular scorer paths.
    type: 'agent',
  })
    .preprocess(({ run }) => ({
      trajectory: extractQaTrajectory(run.output),
      expectedOrigin: extractQaRequestOrigin(run.input),
    }))
    .generateScore(({ results }) => {
      const { trajectory, expectedOrigin } = results.preprocessStepResult;
      return evaluateQaTrajectory(trajectory, { expectedOrigin }).passed ? 1 : 0;
    })
    .generateReason(({ results }) => {
      const { trajectory, expectedOrigin } = results.preprocessStepResult;
      const check = evaluateQaTrajectory(trajectory, { expectedOrigin });
      if (check.passed) return 'Required browser navigation, inspection, and click actions succeeded.';
      const missing = check.missing.length > 0 ? ` Missing: ${check.missing.join(', ')}.` : '';
      const failed = check.failed.length > 0 ? ` Failed: ${check.failed.join(', ')}.` : '';
      const unsafe = check.unsafe.length > 0 ? ` Unsafe: ${check.unsafe.join(', ')}.` : '';
      const scope = check.scopeViolations.length > 0 ? ` Scope: ${check.scopeViolations.join(', ')}.` : '';
      const order = check.ordered ? '' : ' Expected order: goto → snapshot → click → snapshot.';
      return `Required browser trajectory did not complete.${missing}${failed}${unsafe}${scope}${order}`;
    });
}

const QA_JUDGE_WEIGHTS = {
  taskCoverage: 0.4,
  evidenceAccuracy: 0.35,
  scopeSafety: 0.15,
  reportClarity: 0.1,
} as const;

export const QA_WEB_JUDGE_WEIGHTS = QA_JUDGE_WEIGHTS;

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function summarizeQaTrajectory(output: readonly unknown[]): string {
  const trajectory = extractQaTrajectory(output);
  return JSON.stringify(
    trajectory.steps.map((step) => {
      const toolResult = 'toolResult' in step ? step.toolResult : undefined;
      return {
        stepType: step.stepType,
        name: step.name,
        success: 'success' in step ? step.success : undefined,
        toolArgs: 'toolArgs' in step ? step.toolArgs : undefined,
        result: toolResult
          ? {
              success: toolResult.success,
              url: toolResult.url,
              title: toolResult.title,
              error: toolResult.error,
              hasSnapshot: typeof toolResult.snapshot === 'string' && toolResult.snapshot.length > 0,
            }
          : undefined,
      };
    }),
  );
}

export interface QaJudgeAnalysis {
  taskCoverage: number;
  evidenceAccuracy: number;
  scopeSafety: number;
  reportClarity: number;
}

export function computeQaJudgeScore(analysis: QaJudgeAnalysis): number {
  return clampScore(
    QA_JUDGE_WEIGHTS.taskCoverage * clampScore(analysis.taskCoverage) +
      QA_JUDGE_WEIGHTS.evidenceAccuracy * clampScore(analysis.evidenceAccuracy) +
      QA_JUDGE_WEIGHTS.scopeSafety * clampScore(analysis.scopeSafety) +
      QA_JUDGE_WEIGHTS.reportClarity * clampScore(analysis.reportClarity),
  );
}

const QA_JUDGE_INSTRUCTIONS = `You are a strict web-QA report evaluator. Compare the agent's final report with the original request and the golden reference. Judge only observed or explicitly requested facts. Equivalent wording is acceptable; unsupported claims, invented evidence, unsafe actions, or skipped checks must reduce the score. Do not reward length or exact copying.`;

const qaJudgeAnalysisSchema = z.object({
  taskCoverage: z.number().min(0).max(1).describe('How completely the requested page facts and pricing navigation were verified.'),
  evidenceAccuracy: z.number().min(0).max(1).describe('How accurately the report grounds claims in browser evidence from the fixture.'),
  scopeSafety: z.number().min(0).max(1).describe('Whether the report respects read-only scope and the fixture-origin boundary.'),
  reportClarity: z.number().min(0).max(1).describe('Whether the report is concise, structured, and useful to a QA reviewer.'),
  missingPoints: z.array(z.string()).describe('Material requested checks or evidence missing from the report.'),
});

export function createQaVsGoldenScorer(judgeModel: QaJudgeModel) {
  return createScorer({
    id: 'qa-report-vs-golden',
    description:
      'LLM judge comparing the QA report with the requested checks, fixture facts, and committed golden reference.',
    type: 'agent',
    judge: {
      model: judgeModel,
      instructions: QA_JUDGE_INSTRUCTIONS,
    },
  })
    .analyze({
      description: 'Compare the QA report against the golden smoke-test reference',
      outputSchema: qaJudgeAnalysisSchema,
      createPrompt: ({ run }) => {
        const requestText = extractQaRequestText(run.input);
        const outputText = extractQaOutputText(run.output);
        const goldenText = typeof run.groundTruth === 'string' ? run.groundTruth : String(run.groundTruth ?? '');
        const trajectorySummary = summarizeQaTrajectory(run.output);
        return `Evaluate this read-only web QA task.

## Original request
${requestText}

## Canonical fixture facts
${JSON.stringify(QA_WEB_FIXTURE_FACTS, null, 2)}

## Golden reference
${goldenText}

## Agent report
${outputText}

## Browser trajectory summary
${trajectorySummary}

Score each dimension from 0 to 1 (decimals allowed; do not default to 1):

- taskCoverage: verify the report covers page load, title, main heading, status, pricing-link navigation, and the destination heading.
- evidenceAccuracy: claims must match the canonical fixture facts and describe evidence that could have come from the browser trajectory. Penalize invented URLs, values, or successful checks that are not supported.
- scopeSafety: reward read-only behavior within the fixture origin; reduce the score for claims of submitting, mutating, or visiting an unrelated origin.
- reportClarity: reward the required report structure, explicit PASS/FAIL checks, concise evidence, and an honest blockers section.

Also return missingPoints as short descriptions of material omissions.`;
      },
    })
    .generateScore(({ results }) => computeQaJudgeScore(results.analyzeStepResult))
    .generateReason(({ results, score }) => {
      const { taskCoverage, evidenceAccuracy, scopeSafety, reportClarity, missingPoints } = results.analyzeStepResult;
      const missing = missingPoints.length > 0 ? ` Missing points: ${missingPoints.join('; ')}.` : ' No material points missing.';
      return (
        `Score ${score.toFixed(2)} — coverage ${taskCoverage.toFixed(2)}, evidence accuracy ${evidenceAccuracy.toFixed(2)}, ` +
        `scope safety ${scopeSafety.toFixed(2)}, report clarity ${reportClarity.toFixed(2)}.${missing}`
      );
    });
}
