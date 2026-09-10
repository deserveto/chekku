import { describe, expect, it } from 'vitest';

import {
  MIN_BRIEF_OUTPUT_CHARS,
  REQUIRED_BRIEF_SECTIONS,
  computeStrategyJudgeScore,
  createStrategyBriefStructureScorer,
  createStrategyVsGoldenScorer,
  evaluateBriefStructure,
  extractStrategyOutputText,
} from './scorers.js';
import { SOCIAL_STRATEGY_EVAL_CASES } from './cases.js';

const VALID_BRIEF = `# Content Strategy Brief

Project: AtlasFleet
Role: Content Strategist

## Objective

Build credible brand awareness through education-first content.

## Target Audience

Operations managers of mid-market distribution companies.

## Key Topics

Transparency, fuel efficiency, digitalization.

## Deliverables

Eight content ideas across LinkedIn and Instagram with a weekly cadence, each
carrying a working title, platform, format, and intent. This block also pads
the text past the minimum length gate so the structure check exercises the
section detection rather than the length floor.`;

function messageOutput(text: string): unknown {
  return [
    {
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text: 'Buatkan strategi konten untuk brand kami.' }],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  ];
}

/** The agent-typed scorer run input (`ScorerRunInputForAgent`), cast — the runtime only reads the message arrays through the defensive extractor. */
function agentScorerInput(): never {
  return {
    inputMessages: [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Buatkan strategi konten.' }] },
    ],
    rememberedMessages: [],
    systemMessages: [],
    taggedSystemMessages: {},
  } as never;
}

describe('extractStrategyOutputText', () => {
  it('passes plain strings through (trimmed)', () => {
    expect(extractStrategyOutputText('  brief text  ')).toBe('brief text');
  });

  it('extracts text from the 1.50.1 scoringData shape (content as { format, parts })', () => {
    const runOutput = [
      {
        id: 'm-1',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'text', text: '# Content Strategy Brief' },
            { type: 'tool-invocation', toolName: 'search_web' },
            { type: 'text', text: 'body text' },
          ],
        },
      },
    ];
    expect(extractStrategyOutputText(runOutput)).toBe('# Content Strategy Brief\n\nbody text');
  });

  it('extracts text from UIMessage-shaped output (top-level parts)', () => {
    const uiOutput = [
      {
        id: 'ui-1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '# Content Strategy Brief' },
          { type: 'text', text: 'body text' },
          { type: 'tool-invocation', toolName: 'search_web', state: 'output-error' },
        ],
      },
    ];
    expect(extractStrategyOutputText(uiOutput)).toBe('# Content Strategy Brief\n\nbody text');
  });

  it('joins text parts of every message in the array', () => {
    const extracted = extractStrategyOutputText(messageOutput('part one.'));
    expect(extracted).toBe('Buatkan strategi konten untuk brand kami.\n\npart one.');
  });

  it('ignores non-text parts and non-object entries', () => {
    expect(
      extractStrategyOutputText([
        null,
        { content: [{ type: 'tool-invocation', state: 'result' }, { type: 'text', text: 'kept' }] },
        { content: 'plain string content' },
      ]),
    ).toBe('kept\n\nplain string content');
  });

  it('returns empty string for unknown shapes', () => {
    expect(extractStrategyOutputText({ unexpected: true })).toBe('');
    expect(extractStrategyOutputText(undefined)).toBe('');
  });
});

describe('evaluateBriefStructure', () => {
  it('accepts a valid brief', () => {
    const check = evaluateBriefStructure(VALID_BRIEF);
    expect(check.missing).toEqual([]);
    expect(check.present).toEqual([...REQUIRED_BRIEF_SECTIONS]);
    expect(check.substantive).toBe(true);
  });

  it('detects missing sections case-insensitively', () => {
    const stripped = VALID_BRIEF.replace('## Deliverables', '## Rencana');
    const check = evaluateBriefStructure(stripped);
    expect(check.missing).toEqual(['## Deliverables']);
    expect(check.present).not.toContain('## Deliverables');
  });

  it('marks short outputs as non-substantive', () => {
    const short = '# Content Strategy Brief\n## Objective\n## Target Audience\n## Key Topics\n## Deliverables';
    expect(short.length).toBeLessThan(MIN_BRIEF_OUTPUT_CHARS);
    expect(evaluateBriefStructure(short).substantive).toBe(false);
  });

  it('covers both committed golden references', () => {
    for (const evalCase of SOCIAL_STRATEGY_EVAL_CASES) {
      expect(evaluateBriefStructure(evalCase.groundTruth).missing).toEqual([]);
    }
  });
});

describe('computeStrategyJudgeScore', () => {
  it('weights coverage, scope alignment, and factual consistency', () => {
    expect(computeStrategyJudgeScore({ coverage: 1, scopeAlignment: 1, factualConsistency: 1 })).toBe(1);
    expect(computeStrategyJudgeScore({ coverage: 0, scopeAlignment: 0, factualConsistency: 0 })).toBe(0);
    expect(computeStrategyJudgeScore({ coverage: 0.8, scopeAlignment: 0.6, factualConsistency: 1 })).toBeCloseTo(
      0.5 * 0.8 + 0.3 * 0.6 + 0.2 * 1,
      10,
    );
  });

  it('clamps out-of-range judge output', () => {
    expect(computeStrategyJudgeScore({ coverage: 1.5, scopeAlignment: 1, factualConsistency: 1 })).toBe(1);
  });
});

describe('createStrategyBriefStructureScorer', () => {
  it('scores a valid brief 1 without any LLM', async () => {
    const scorer = createStrategyBriefStructureScorer();
    const result = await scorer.run({
      input: agentScorerInput(),
      output: messageOutput(VALID_BRIEF) as never,
      groundTruth: 'golden',
    });
    expect(result.score).toBe(1);
    expect(result.reason).toBe('Brief contains every required section.');
  });

  it('scores a structurally broken output 0 and names the missing sections', async () => {
    const scorer = createStrategyBriefStructureScorer();
    const result = await scorer.run({
      input: agentScorerInput(),
      output: messageOutput('Berikut ide konten singkat tanpa struktur brief sama sekali.'.repeat(6)) as never,
      groundTruth: 'golden',
    });
    expect(result.score).toBe(0);
    expect(String(result.reason)).toContain('# Content Strategy Brief');
  });
});

describe('createStrategyVsGoldenScorer', () => {
  it('builds the judge scorer without invoking the judge model', () => {
    const scorer = createStrategyVsGoldenScorer({} as never);
    expect(scorer.id).toBe('strategy-vs-golden');
    expect(scorer.getSteps().map((step) => step.name)).toEqual(['analyze', 'generateScore', 'generateReason']);
  });
});
