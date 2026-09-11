import { describe, expect, it } from 'vitest';
import type { ScorerRunInputForAgent, ToolCallStep, Trajectory } from '@mastra/core/evals';

import {
  QA_WEB_FIXTURE_FACTS,
  QA_WEB_GOLDEN_REFERENCE,
  createQaWebEvalCase,
} from './cases.js';
import {
  MIN_QA_REPORT_OUTPUT_CHARS,
  REQUIRED_QA_REPORT_SECTIONS,
  buildQaJudgePrompt,
  computeQaJudgeScore,
  evaluateQaReportStructure,
  evaluateQaTrajectory,
  extractQaRequestOrigin,
  extractQaTrajectory,
  extractQaOutputText,
} from './scorers.js';

const VALID_REPORT = `# QA Web Smoke Test Report

## Summary

PASS — public smoke test completed successfully.

## Checks

- Page load: PASS — the fixture loaded successfully.
- Page title: PASS — Chekku QA Fixture.
- Main heading: PASS — Checkout Smoke Test.
- Status: PASS — Ready for testing.
- Pricing navigation: PASS — the link resolved to /pricing.

## Evidence

- The initial page snapshot showed the expected title, heading, status, and View pricing link.
- The pricing page opened after clicking View pricing and remained inside the fixture origin.

## Blockers

None.
`;

function messageOutput(text: string): unknown {
  return [
    {
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text: 'Lakukan smoke test pada website.' }],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  ];
}

function agentScorerInput(): ScorerRunInputForAgent {
  return {
    inputMessages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: 'text', text: 'Lakukan smoke test pada http://127.0.0.1:43123/.' }],
        },
      },
    ],
    rememberedMessages: [],
    systemMessages: [],
    taggedSystemMessages: {},
  };
}

function successfulTool(name: string): ToolCallStep {
  return {
    stepType: 'tool_call',
    name,
    success: true,
    toolResult: { success: true },
  };
}

function completeTrajectory(): Trajectory {
  return {
    steps: [
      successfulTool('browser_goto'),
      successfulTool('browser_snapshot'),
      successfulTool('browser_click'),
      successfulTool('browser_snapshot'),
    ],
  };
}

function completeTrajectoryForOrigin(origin: string): Trajectory {
  const homeUrl = `${origin}/.`;
  const pricingUrl = `${origin}/pricing`;
  return {
    steps: [
      { ...successfulTool('browser_goto'), toolArgs: { url: homeUrl }, toolResult: { success: true, url: homeUrl } },
      {
        ...successfulTool('browser_snapshot'),
        toolResult: { success: true, url: homeUrl, snapshot: 'home' },
      },
      { ...successfulTool('browser_click'), toolResult: { success: true, url: pricingUrl } },
      {
        ...successfulTool('browser_snapshot'),
        toolResult: { success: true, url: pricingUrl, snapshot: 'pricing' },
      },
    ],
  };
}

describe('extractQaOutputText', () => {
  it('passes plain strings through after trimming', () => {
    expect(extractQaOutputText('  report text  ')).toBe('report text');
  });

  it('extracts text from Mastra 1.50.1 content parts', () => {
    const output = [
      {
        id: 'm-1',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'text', text: '# QA Web Smoke Test Report' },
            { type: 'tool-invocation', toolName: 'browser_snapshot' },
            { type: 'text', text: 'body text' },
          ],
        },
      },
    ];
    expect(extractQaOutputText(output)).toBe('# QA Web Smoke Test Report\n\nbody text');
  });

  it('extracts text from UI-message parts and ignores tool parts', () => {
    const output = [
      {
        id: 'ui-1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '# QA Web Smoke Test Report' },
          { type: 'text', text: 'body text' },
          { type: 'tool-invocation', toolName: 'browser_snapshot' },
        ],
      },
    ];
    expect(extractQaOutputText(output)).toBe('# QA Web Smoke Test Report\n\nbody text');
  });

  it('joins text from the supported message array shapes', () => {
    expect(extractQaOutputText(messageOutput('report text'))).toBe('report text');
  });

  it('returns an empty string for unknown shapes', () => {
    expect(extractQaOutputText({ unexpected: true })).toBe('');
    expect(extractQaOutputText(undefined)).toBe('');
  });

  it('falls back to all messages when a preferred role is absent', () => {
    expect(
      extractQaRequestOrigin([
        { role: 'assistant', content: [{ type: 'text', text: 'Previous answer.' }] },
        { role: 'human', content: [{ type: 'text', text: 'Open https://127.0.0.1:43123/.' }] },
      ]),
    ).toBe('https://127.0.0.1:43123');
  });
});

describe('extractQaTrajectory', () => {
  it('normalizes Mastra UI-message parts at the message root', () => {
    const trajectory = extractQaTrajectory(trajectoryMessageOutput());
    expect(trajectory.steps.map((step) => step.name)).toEqual([
      'browser_goto',
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
    ]);
  });
});

describe('createQaWebEvalCase', () => {
  it('injects a normalized local fixture URL into the critical-path request', () => {
    const evalCase = createQaWebEvalCase('http://127.0.0.1:43123/');
    expect(evalCase.id).toBe('public-read-only-smoke-test');
    expect(evalCase.input).toContain('http://127.0.0.1:43123/.');
    expect(evalCase.input).toContain(QA_WEB_FIXTURE_FACTS.pricingPath);
    expect(evalCase.groundTruth).toBe(QA_WEB_GOLDEN_REFERENCE);
  });
});

describe('trajectory origin requirements', () => {
  it('fails closed when the request origin cannot be determined', () => {
    const check = evaluateQaTrajectory(completeTrajectory());

    expect(check.passed).toBe(false);
    expect(check.scopeViolations).toContain('request-origin:missing');
  });
});

describe('evaluateQaReportStructure', () => {
  it('accepts a complete substantive report', () => {
    const check = evaluateQaReportStructure(VALID_REPORT);
    expect(check.missing).toEqual([]);
    expect(check.present).toEqual([...REQUIRED_QA_REPORT_SECTIONS]);
    expect(check.substantive).toBe(true);
    expect(check.checksSubstantive).toBe(true);
    expect(check.evidenceSubstantive).toBe(true);
    expect(check.blockersSubstantive).toBe(true);
  });

  it('requires exact heading lines rather than substring matches', () => {
    const check = evaluateQaReportStructure(
      VALID_REPORT.replace('## Evidence', '## Evidence and findings'),
    );
    expect(check.missing).toContain('## Evidence');
    expect(check.evidenceSubstantive).toBe(false);
  });

  it('recognizes Indonesian wording that says the page was loaded', () => {
    const check = evaluateQaReportStructure(
      VALID_REPORT.replace(
        '- Page load: PASS — the fixture loaded successfully.',
        '- Halaman dimuat dengan berhasil: PASS.',
      ),
    );

    expect(check.missingChecks).not.toContain('page load');
    expect(check.checksSubstantive).toBe(true);
  });

  it('rejects a status-only summary as non-substantive', () => {
    expect(
      evaluateQaReportStructure(VALID_REPORT.replace('PASS — public smoke test completed successfully.', 'PASS'))
        .summarySubstantive,
    ).toBe(false);
  });

  it('rejects an empty evidence section', () => {
    const withoutEvidence = VALID_REPORT.replace(
      '## Evidence\n\n- The initial page snapshot showed the expected title, heading, status, and View pricing link.\n- The pricing page opened after clicking View pricing and remained inside the fixture origin.\n',
      '## Evidence\n\n## Blockers\n',
    );
    const check = evaluateQaReportStructure(withoutEvidence);
    expect(check.evidenceSubstantive).toBe(false);
  });

  it('requires one result-bearing row for each requested check', () => {
    const combinedChecks = VALID_REPORT.replace(
      '- Page load: PASS — the fixture loaded successfully.\n- Page title: PASS — Chekku QA Fixture.\n- Main heading: PASS — Checkout Smoke Test.\n- Status: PASS — Ready for testing.\n- Pricing navigation: PASS — the link resolved to /pricing.\n',
      '- Page load, title, heading, status, and pricing: PASS PASS PASS PASS PASS — combined.\n',
    );
    const check = evaluateQaReportStructure(combinedChecks);
    expect(check.checksSubstantive).toBe(false);
    expect(check.missingChecks.length).toBeGreaterThan(0);
  });

  it('rejects placeholder-only summary, evidence, and blockers text', () => {
    expect(evaluateQaReportStructure(VALID_REPORT.replace('PASS — public smoke test completed successfully.', '?')).summarySubstantive).toBe(
      false,
    );
    expect(
      evaluateQaReportStructure(
        VALID_REPORT.replace(
          '- The initial page snapshot showed the expected title, heading, status, and View pricing link.\n- The pricing page opened after clicking View pricing and remained inside the fixture origin.',
          'N/A.',
        ),
      ).evidenceSubstantive,
    ).toBe(false);
    expect(evaluateQaReportStructure(VALID_REPORT.replace('None.\n', 'N/A.\n')).blockersSubstantive).toBe(false);
  });

  it('rejects a report with empty checks or blockers sections', () => {
    const withoutChecks = VALID_REPORT.replace(
      '- Page load: PASS — the fixture loaded successfully.\n- Page title: PASS — Chekku QA Fixture.\n- Main heading: PASS — Checkout Smoke Test.\n- Status: PASS — Ready for testing.\n- Pricing navigation: PASS — the link resolved to /pricing.\n',
      '',
    );
    const withoutBlockers = VALID_REPORT.replace('None.\n', '');
    expect(evaluateQaReportStructure(withoutChecks).checksSubstantive).toBe(false);
    expect(evaluateQaReportStructure(withoutBlockers).blockersSubstantive).toBe(false);
  });

  it('rejects reports below the minimum output length', () => {
    const short = REQUIRED_QA_REPORT_SECTIONS.join('\n');
    expect(short.length).toBeLessThan(MIN_QA_REPORT_OUTPUT_CHARS);
    expect(evaluateQaReportStructure(short).substantive).toBe(false);
  });

  it('accepts the committed golden reference', () => {
    expect(evaluateQaReportStructure(QA_WEB_GOLDEN_REFERENCE).missing).toEqual([]);
    expect(evaluateQaReportStructure(QA_WEB_GOLDEN_REFERENCE).evidenceSubstantive).toBe(true);
  });
});

describe('evaluateQaTrajectory', () => {
  it('accepts the required successful browser path', () => {
    const check = evaluateQaTrajectory(completeTrajectoryForOrigin('http://127.0.0.1:43123'), {
      expectedOrigin: 'http://127.0.0.1:43123',
    });
    expect(check.missing).toEqual([]);
    expect(check.failed).toEqual([]);
    expect(check.unsafe).toEqual([]);
    expect(check.ordered).toBe(true);
    expect(check.passed).toBe(true);
  });

  it('accepts the dot-segment home path used by the eval prompt', () => {
    const homeUrl = 'http://127.0.0.1:43123/.';
    const pricingUrl = 'http://127.0.0.1:43123/pricing';
    const check = evaluateQaTrajectory(
      {
        steps: [
          { ...successfulTool('browser_goto'), toolArgs: { url: homeUrl }, toolResult: { success: true, url: homeUrl } },
          {
            ...successfulTool('browser_snapshot'),
            toolResult: { success: true, url: homeUrl, snapshot: 'home' },
          },
          { ...successfulTool('browser_click'), toolResult: { success: true, url: pricingUrl } },
          {
            ...successfulTool('browser_snapshot'),
            toolResult: { success: true, url: pricingUrl, snapshot: 'pricing' },
          },
        ],
      },
      { expectedOrigin: 'http://127.0.0.1:43123' },
    );

    expect(check.passed).toBe(true);
    expect(check.scopeViolations).toEqual([]);
  });

  it('fails when off-origin URLs are the only defect', () => {
    const check = evaluateQaTrajectory(completeTrajectoryForOrigin('https://outside.example'), {
      expectedOrigin: 'http://127.0.0.1:43123',
    });

    expect(check.missing).toEqual([]);
    expect(check.failed).toEqual([]);
    expect(check.unsafe).toEqual([]);
    expect(check.ordered).toBe(true);
    expect(check.scopeViolations.length).toBeGreaterThan(0);
    expect(check.passed).toBe(false);
  });

  it('allows benign clicks before the eventual pricing navigation', () => {
    const homeUrl = 'http://127.0.0.1:43123/.';
    const pricingUrl = 'http://127.0.0.1:43123/pricing';
    const check = evaluateQaTrajectory(
      {
        steps: [
          { ...successfulTool('browser_goto'), toolArgs: { url: homeUrl }, toolResult: { success: true, url: homeUrl } },
          { ...successfulTool('browser_snapshot'), toolResult: { success: true, url: homeUrl, snapshot: 'home' } },
          { ...successfulTool('browser_click'), toolArgs: { ref: '@e2' }, toolResult: { success: true } },
          {
            ...successfulTool('browser_snapshot'),
            toolResult: { success: true, url: homeUrl, snapshot: 'home after benign click' },
          },
          { ...successfulTool('browser_click'), toolArgs: { ref: '@e1' }, toolResult: { success: true, url: pricingUrl } },
          { ...successfulTool('browser_snapshot'), toolResult: { success: true, url: pricingUrl, snapshot: 'pricing' } },
        ],
      },
      { expectedOrigin: 'http://127.0.0.1:43123' },
    );

    expect(check.passed).toBe(true);
    expect(check.scopeViolations).toEqual([]);
  });

  it('rejects browser navigation helpers outside the read-only action contract', () => {
    const base = completeTrajectoryForOrigin('http://127.0.0.1:43123');
    const check = evaluateQaTrajectory(
      {
        steps: [
          ...base.steps,
          { ...successfulTool('browser_tabs'), toolArgs: { action: 'list' } },
          successfulTool('browser_back'),
        ],
      },
      { expectedOrigin: 'http://127.0.0.1:43123' },
    );

    expect(check.unsafe).toEqual(['browser_tabs', 'browser_back']);
    expect(check.passed).toBe(false);
  });

  it('reports missing required browser actions', () => {
    const check = evaluateQaTrajectory({ steps: [successfulTool('browser_goto')] });
    expect(check.passed).toBe(false);
    expect(check.missing).toEqual(['browser_snapshot', 'browser_click']);
  });

  it('reports failed required tool calls', () => {
    const trajectory: Trajectory = {
      steps: [
        successfulTool('browser_goto'),
        {
          stepType: 'tool_call',
          name: 'browser_snapshot',
          success: false,
          toolResult: { success: false, error: 'navigation failed' },
        },
        successfulTool('browser_click'),
      ],
    };
    const check = evaluateQaTrajectory(trajectory);
    expect(check.passed).toBe(false);
    expect(check.failed).toEqual(['browser_snapshot']);
  });

  it('does not use a failed step to satisfy the ordered browser path', () => {
    const trajectory: Trajectory = {
      steps: [
        successfulTool('browser_goto'),
        {
          stepType: 'tool_call',
          name: 'browser_snapshot',
          success: false,
          toolResult: { success: false, error: 'snapshot failed' },
        },
        successfulTool('browser_click'),
        successfulTool('browser_snapshot'),
      ],
    };
    const check = evaluateQaTrajectory(trajectory);
    expect(check.ordered).toBe(false);
    expect(check.passed).toBe(false);
  });

  it('rejects an out-of-order path, unsafe tool, or off-origin navigation', () => {
    const trajectory: Trajectory = {
      steps: [
        {
          ...successfulTool('browser_goto'),
          toolArgs: { url: 'https://outside.example/' },
          toolResult: { success: true, url: 'https://outside.example/' },
        },
        successfulTool('browser_click'),
        successfulTool('browser_snapshot'),
        successfulTool('browser_goto'),
        {
          ...successfulTool('browser_type'),
          toolArgs: { ref: '@e1', text: 'unsafe' },
        },
      ],
    };
    const check = evaluateQaTrajectory(trajectory, { expectedOrigin: 'http://127.0.0.1:43123' });
    expect(check.passed).toBe(false);
    expect(check.ordered).toBe(false);
    expect(check.unsafe).toEqual(['browser_type']);
    expect(check.scopeViolations.length).toBeGreaterThan(0);
  });

  it('ignores non-tool trajectory steps', () => {
    const check = evaluateQaTrajectory({
      steps: [{ stepType: 'model_generation', name: 'model' }],
    });
    expect(check.passed).toBe(false);
    expect(check.missing).toEqual(['browser_goto', 'browser_snapshot', 'browser_click']);
  });
});

describe('computeQaJudgeScore', () => {
  it('uses the documented weighted dimensions', () => {
    expect(
      computeQaJudgeScore({
        taskCoverage: 1,
        evidenceAccuracy: 1,
        scopeSafety: 1,
        reportClarity: 1,
      }),
    ).toBe(1);
    expect(
      computeQaJudgeScore({
        taskCoverage: 0.8,
        evidenceAccuracy: 0.6,
        scopeSafety: 1,
        reportClarity: 0.5,
      }),
    ).toBeCloseTo(0.4 * 0.8 + 0.35 * 0.6 + 0.15 * 1 + 0.1 * 0.5, 10);
  });

  it('clamps out-of-range judge values', () => {
    expect(
      computeQaJudgeScore({
        taskCoverage: 2,
        evidenceAccuracy: 1,
        scopeSafety: 1,
        reportClarity: 1,
      }),
    ).toBe(1);
    expect(
      computeQaJudgeScore({
        taskCoverage: -1,
        evidenceAccuracy: 0,
        scopeSafety: 0,
        reportClarity: 0,
      }),
    ).toBe(0);
  });
});

describe('buildQaJudgePrompt', () => {
  it('fences every model-controlled judge input block', () => {
    const prompt = buildQaJudgePrompt({
      requestText: 'request data',
      goldenText: 'golden data',
      outputText: 'report data',
      trajectorySummary: 'trajectory data',
    });

    expect(prompt).toContain('<<<BEGIN_ORIGINAL_REQUEST>>>\nrequest data\n<<<END_ORIGINAL_REQUEST>>>');
    expect(prompt).toContain('<<<BEGIN_GOLDEN_REFERENCE>>>\ngolden data\n<<<END_GOLDEN_REFERENCE>>>');
    expect(prompt).toContain('<<<BEGIN_AGENT_REPORT>>>\nreport data\n<<<END_AGENT_REPORT>>>');
    expect(prompt).toContain('<<<BEGIN_BROWSER_TRAJECTORY>>>\ntrajectory data\n<<<END_BROWSER_TRAJECTORY>>>');
  });
});

describe('QA scorer factories', () => {
  it('builds deterministic scorers without invoking an LLM', async () => {
    const { createQaReportStructureScorer, createQaTrajectoryScorer } = await import('./scorers.js');
    const reportScorer = createQaReportStructureScorer();
    const trajectoryScorer = createQaTrajectoryScorer();

    const reportResult = await reportScorer.run({
      input: agentScorerInput(),
      output: messageOutput(VALID_REPORT) as never,
      groundTruth: QA_WEB_GOLDEN_REFERENCE,
    });
    const trajectoryResult = await trajectoryScorer.run({
      input: agentScorerInput(),
      output: trajectoryMessageOutput() as never,
      groundTruth: QA_WEB_GOLDEN_REFERENCE,
    });

    expect(reportResult.score).toBe(1);
    expect(trajectoryResult.score).toBe(1);
  });
});

function trajectoryMessageOutput(): unknown {
  const homeUrl = 'http://127.0.0.1:43123/';
  const pricingUrl = 'http://127.0.0.1:43123/pricing';
  const invocations = [
    { toolName: 'browser_goto', args: { url: homeUrl }, result: { success: true, url: homeUrl } },
    {
      toolName: 'browser_snapshot',
      args: {},
      result: { success: true, url: homeUrl, title: QA_WEB_FIXTURE_FACTS.title, snapshot: 'home' },
    },
    { toolName: 'browser_click', args: { ref: '@e1' }, result: { success: true, url: pricingUrl } },
    {
      toolName: 'browser_snapshot',
      args: {},
      result: { success: true, url: pricingUrl, title: 'Pricing', snapshot: 'pricing' },
    },
  ];
  return [
    {
      id: 'tool-message',
      role: 'assistant',
      parts: invocations.map((toolInvocation) => ({
        type: 'tool-invocation',
        toolInvocation: { ...toolInvocation, state: 'result' },
      })),
    },
  ];
}
