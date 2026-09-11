/**
 * On-demand Mastra eval for the QA Web Agent's read-only public smoke-test
 * critical path.
 *
 * Run from the repository root with:
 *   npm run eval:qa-web
 *
 * This file is intentionally outside the regular Vitest include pattern. It
 * makes one live agent turn, a possible memory-title call, and one judge call,
 * then prints the score report.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

import { chromium } from 'playwright-core';
import { describe, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { runEvals } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';

import { env } from '../../config/env.js';
import { createQaWebEvalCase, type QaWebEvalCase } from './cases.js';
import { startQaWebFixture, type QaWebFixture } from './fixture.js';
import {
  createQaReportStructureScorer,
  createQaTrajectoryScorer,
  createQaVsGoldenScorer,
} from './scorers.js';

export const QA_WEB_GOLDEN_THRESHOLD = 0.6;

const EVAL_RESOURCE_ID = 'evals';

type EvalRunResult = Awaited<ReturnType<typeof runEvals>>;

function assertLlmConfigured(): void {
  const missing = (['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_DEFAULT_MODEL'] as const).filter(
    (key) => !env[key].trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `The qa-web eval needs a live model gateway. Missing in agent/.env: ${missing.join(', ')}. ` +
        'Set them (LLM_BASE_URL, LLM_API_KEY, LLM_DEFAULT_MODEL) and re-run npm run eval:qa-web.',
    );
  }
}

function assertBrowserAvailable(): void {
  const configuredPath = env.BROWSER_EXECUTABLE_PATH.trim();
  const executablePath = configuredPath || chromium.executablePath();
  const executableAvailable = (() => {
    if (!executablePath || !existsSync(executablePath)) return false;
    try {
      const stats = statSync(executablePath);
      return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  })();
  if (!executableAvailable) {
    const selected = configuredPath ? `BROWSER_EXECUTABLE_PATH (${configuredPath})` : 'Playwright Chromium';
    throw new Error(
      `${selected} is not available. Install Chromium with ` +
        '`npx playwright install chromium` (add `--with-deps` on a fresh Linux host), or set BROWSER_EXECUTABLE_PATH.',
    );
  }
}

async function buildJudgeModel() {
  const [{ OpenAICompatibleGateway }, { OPENAI_COMPATIBLE_PROVIDER_ID, stripOpenAICompatibleRouterId }, { getServerModel }] =
    await Promise.all([
      import('../../mastra/gateways/openai-compatible.js'),
      import('../../mastra/gateways/openai-compatible-model.js'),
      import('../../providers/model.js'),
    ]);
  const gateway = new OpenAICompatibleGateway();
  return gateway.resolveLanguageModel({
    modelId: stripOpenAICompatibleRouterId(getServerModel()),
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    apiKey: env.LLM_API_KEY.trim(),
  });
}

function createEvalMemoryOptions(): { memory: { thread: string; resource: string } } {
  return {
    memory: {
      thread: `qa-web-agent-${EVAL_RESOURCE_ID}-${randomUUID()}`,
      resource: EVAL_RESOURCE_ID,
    },
  };
}

function formatScore(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(2) : String(value);
}

function printCaseScorerReport(
  evalCase: QaWebEvalCase,
  scorerResults: Record<string, { score?: unknown; reason?: unknown }>,
): void {
  console.log(`\n[case ${evalCase.id}]`);
  for (const [scorerId, result] of Object.entries(scorerResults)) {
    const reason = typeof result.reason === 'string' ? result.reason : '';
    console.log(`  ${scorerId}: ${formatScore(result.score)}${reason ? ` — ${reason}` : ''}`);
  }
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function printSummary(caseResults: Array<{ evalCase: QaWebEvalCase; result: EvalRunResult }>): void {
  const gateScores = new Map<string, number[]>();
  const thresholdScores = new Map<string, number[]>();

  for (const { result } of caseResults) {
    for (const gate of result.gateResults ?? []) {
      gateScores.set(gate.id, [...(gateScores.get(gate.id) ?? []), gate.score]);
    }
    for (const threshold of result.thresholdResults ?? []) {
      thresholdScores.set(threshold.id, [
        ...(thresholdScores.get(threshold.id) ?? []),
        threshold.averageScore,
      ]);
    }
  }

  let allGatesPassed = true;
  let allThresholdsPassed = true;

  console.log('\n──────────────────────────────────────────────');
  console.log('QA Web Agent eval — summary');
  console.log(`Cases evaluated: ${caseResults.length}/1`);

  for (const [id, scores] of gateScores) {
    const score = average(scores);
    const passed = scores.every((value) => value >= 1);
    if (!passed) allGatesPassed = false;
    console.log(`  gate ${id}: ${score.toFixed(2)} [${passed ? 'PASS' : 'FAIL'}]`);
  }

  for (const [id, scores] of thresholdScores) {
    const score = average(scores);
    const passed = score >= QA_WEB_GOLDEN_THRESHOLD;
    if (!passed) allThresholdsPassed = false;
    console.log(
      `  avg ${id}: ${score.toFixed(2)} (threshold ${QA_WEB_GOLDEN_THRESHOLD.toFixed(2)}) [${passed ? 'PASS' : 'MISS'}]`,
    );
  }

  const verdict = !allGatesPassed ? 'failed' : allThresholdsPassed ? 'passed' : 'scored';
  console.log(`VERDICT: ${verdict}`);
  console.log('──────────────────────────────────────────────');
}

describe('eval: qa-web-agent — public read-only smoke test', () => {
  it(
    'scores the browser trajectory and final QA report against the golden reference',
    async () => {
      assertLlmConfigured();
      assertBrowserAvailable();

      let fixture: QaWebFixture | undefined;
      let browserModule: typeof import('../../mastra/browsers.js') | undefined;

      try {
        fixture = await startQaWebFixture();
        const evalCase = createQaWebEvalCase(fixture.baseUrl);

        // Keep the model/agent imports after preflight. Importing qa-web-agent
        // resolves its model factory and otherwise hides the useful missing-env
        // diagnostic behind an import-time error.
        const [{ qaWebAgent }, { OpenAICompatibleGateway }] = await Promise.all([
          import('../../agents/qa-web-agent.js'),
          import('../../mastra/gateways/openai-compatible.js'),
        ]);
        browserModule = await import('../../mastra/browsers.js');

        const judgeModel = await buildJudgeModel();
        const qaTrajectoryScorer = createQaTrajectoryScorer();
        const qaReportStructureScorer = createQaReportStructureScorer();
        const qaVsGoldenScorer = createQaVsGoldenScorer(judgeModel);

        const evalMastra = new Mastra({
          agents: { qaWebAgent },
          gateways: { openAICompatible: new OpenAICompatibleGateway() },
          storage: new InMemoryStore({ id: 'qa-web-eval-storage' }),
          scorers: {
            qaBrowserTrajectory: qaTrajectoryScorer,
            qaReportStructure: qaReportStructureScorer,
            qaReportVsGolden: qaVsGoldenScorer,
          },
        });
        const target = evalMastra.getAgent('qaWebAgent');
        if (!target) throw new Error('Eval Mastra failed to register the QA Web Agent.');

        console.log(
          `Running 1 eval case against qa-web-agent (judge model: ${env.LLM_DEFAULT_MODEL})...`,
        );

        const result = await runEvals({
          target,
          data: [{ input: evalCase.input, groundTruth: evalCase.groundTruth }],
          gates: [qaTrajectoryScorer, qaReportStructureScorer],
          scorers: [{ scorer: qaVsGoldenScorer, threshold: QA_WEB_GOLDEN_THRESHOLD }],
          targetOptions: createEvalMemoryOptions(),
          concurrency: 1,
          onItemComplete: ({ scorerResults }) => printCaseScorerReport(evalCase, scorerResults),
        });

        printSummary([{ evalCase, result }]);

        if (result.summary.totalItems !== 1) {
          throw new Error(
            `QA Web eval ran ${result.summary.totalItems} of 1 case. Check the runner output above for failures.`,
          );
        }
        if (result.verdict === 'failed') {
          throw new Error('QA Web eval gate failed. See the trajectory and report-structure scores above.');
        }
      } finally {
        if (browserModule) {
          try {
            const browserState = await browserModule.browser.getBrowserState();
            if (browserState) {
              const closeResult = await browserModule.browser.closeBrowser();
              if ('success' in closeResult && closeResult.success !== true) {
                console.warn('[qa-web eval] Browser cleanup returned an error result.');
              }
            }
          } catch {
            console.warn('[qa-web eval] Browser cleanup threw an error.');
          }
        }
        try {
          await fixture?.close();
        } catch {
          console.warn('[qa-web eval] Fixture cleanup threw an error.');
        }
      }
    },
    900_000,
  );
});
