import { describe, expect, it } from 'vitest';

import {
  CANONICAL_UNIT_SECTION,
  CANONICAL_UNIT_TEMPLATE,
  REPURPOSED_CAPTION_SECTION,
  parseCanonicalUnit,
  renderCanonicalUnit,
  sectionClose,
  sectionOpen,
  unwrapPostMarkdown,
  wrapPostMarkdown,
  type CanonicalContentUnit,
} from '../canonical-unit.js';

const FULL_UNIT: CanonicalContentUnit = {
  topic: 'Overcoming Remote Team Meeting Fatigue',
  thesis:
    'Meeting fatigue is not caused by meetings themselves; it is caused by default-scheduling 30-minute blocks for discussions that should be asynchronous.',
  hooks: {
    curiosity: 'The 5-minute rule that saved our remote team 12 hours of meetings a week.',
    contrarian: 'Stop scheduling 30-minute meetings. It is ruining your team productivity.',
    dataImpact: '70% of workplace meetings could be a 2-minute async update. Here is our framework:',
  },
  corePoints: [
    'Default to async status updates (Slack/Loom) before booking time.',
    'Cut standard 30-min calendar holds down to 15 minutes.',
    'Require a 1-sentence decision goal in every meeting invite; no agenda = no meeting.',
  ],
  shortFormBrick:
    'Stop booking 30-min meetings.\n\nMost can be a 2-min async update. Our team saved 12 hours/week with one rule: no agenda, no meeting.\n\nWhat is your meeting default?',
  mediumFormBrick:
    'Meeting fatigue is real — but the fix is not fewer meetings, it is shorter ones with clearer goals.\n\nWe cut default holds to 15 minutes and required a one-sentence decision goal in every invite. The result: 12 hours/week reclaimed, and decisions actually get made.',
  visualScriptBrick:
    'Panel 1: Calendar full of 30-min blocks (grey).\nPanel 2: One invite with a one-line goal highlighted.\nPanel 3: The same calendar, mostly empty — reclaimed time.',
  callToAction: 'Reply with the one meeting you cancelled this week and what you did with the hour.',
};

describe('CANONICAL_UNIT_TEMPLATE', () => {
  it('declares every required section in order', () => {
    const requiredHeaders = [
      '[TOPIC]',
      '[THESIS]',
      'HOOKS',
      'CORE POINTS',
      'SHORT-FORM BRICK',
      'MEDIUM-FORM BRICK',
      'VISUAL / VIDEO SCRIPT BRICK',
      'CALL TO ACTION / ENGAGEMENT',
    ];
    for (const header of requiredHeaders) {
      expect(CANONICAL_UNIT_TEMPLATE).toContain(header);
    }
  });

  it('documents the three hook angles', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Curiosity');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Contrarian');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Data/Impact');
  });

  it('instructs the visual script brick as a platform-agnostic sequence of visual concepts', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('sequence of reusable visual concepts');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Do NOT label items "Panel 1');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('one concept can carry it');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Platform-agnostic visual narrative');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Ground every visual in the source');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Do NOT include camera direction');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('voice-over');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('transition effects');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('"carousel", "slide", or "reel"');
    expect(CANONICAL_UNIT_TEMPLATE).not.toContain('Per panel:');
  });

  it('demands a descriptive Purpose instead of generic labels', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Purpose');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('generic labels');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Introduction');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Highlight the healthcare accessibility problem');
  });

  it('prioritizes concrete scenes over symbolic graphics', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('prioritize concrete scenes');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('logos, maps, icons');
    expect(CANONICAL_UNIT_TEMPLATE).toContain("patient's home");
  });

  it('bounds the Overlay to a short phrase, not a sentence', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('3–8 words');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Never a full sentence');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Home Care Jemput Bola');
  });

  it('arranges the concepts as a coherent narrative', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('coherent story');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Problem');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('future implication');
  });

  it('keeps the medium-form brick factual and hedged', () => {
    expect(CANONICAL_UNIT_TEMPLATE).toContain('Keep it factual');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('diharapkan');
    expect(CANONICAL_UNIT_TEMPLATE).toContain('berpotensi');
  });
});

describe('renderCanonicalUnit', () => {
  it('emits every section in order with canonical headers', () => {
    const md = renderCanonicalUnit(FULL_UNIT);
    const headers = [
      '[TOPIC]',
      '[THESIS]',
      'HOOKS',
      'CORE POINTS',
      'SHORT-FORM BRICK',
      'MEDIUM-FORM BRICK',
      'VISUAL / VIDEO SCRIPT BRICK',
      'CALL TO ACTION / ENGAGEMENT',
    ];
    let lastIdx = -1;
    for (const header of headers) {
      const idx = md.indexOf(header);
      expect(idx, `${header} should be present`).toBeGreaterThan(-1);
      expect(idx, `${header} should come after the previous header`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('renders hook angles with their canonical labels', () => {
    const md = renderCanonicalUnit(FULL_UNIT);
    expect(md).toContain('1. Curiosity: ');
    expect(md).toContain('2. Contrarian: ');
    expect(md).toContain('3. Data/Impact: ');
  });

  it('renders core points as bullet lines', () => {
    const md = renderCanonicalUnit(FULL_UNIT);
    expect(md).toContain('- Default to async status updates');
    expect(md).toContain('- Cut standard 30-min calendar holds');
    expect(md).toContain('- Require a 1-sentence decision goal');
  });

  it('trims whitespace on every field', () => {
    const md = renderCanonicalUnit({
      ...FULL_UNIT,
      topic: '  padded topic  ',
      callToAction: '\n  trimmed cta  \n',
    });
    expect(md).toContain('[TOPIC]\npadded topic');
    expect(md).toContain('CALL TO ACTION / ENGAGEMENT\ntrimmed cta');
  });

  it('omits empty hook entries rather than emitting blank lines', () => {
    const md = renderCanonicalUnit({
      ...FULL_UNIT,
      hooks: { curiosity: 'only this one', contrarian: '', dataImpact: '' },
    });
    expect(md).toContain('1. Curiosity: only this one');
    expect(md).not.toContain('2. Contrarian:');
    expect(md).not.toContain('3. Data/Impact:');
  });
});

describe('parseCanonicalUnit', () => {
  it('round-trips a fully populated unit through render → parse', () => {
    const md = renderCanonicalUnit(FULL_UNIT);
    const parsed = parseCanonicalUnit(md);
    expect(parsed).toBeDefined();
    expect(parsed!.topic).toBe(FULL_UNIT.topic);
    expect(parsed!.thesis).toBe(FULL_UNIT.thesis);
    expect(parsed!.hooks.curiosity).toBe(FULL_UNIT.hooks.curiosity);
    expect(parsed!.hooks.contrarian).toBe(FULL_UNIT.hooks.contrarian);
    expect(parsed!.hooks.dataImpact).toBe(FULL_UNIT.hooks.dataImpact);
    expect(parsed!.corePoints).toEqual(FULL_UNIT.corePoints);
    expect(parsed!.shortFormBrick).toBe(FULL_UNIT.shortFormBrick);
    expect(parsed!.mediumFormBrick).toBe(FULL_UNIT.mediumFormBrick);
    expect(parsed!.visualScriptBrick).toBe(FULL_UNIT.visualScriptBrick);
    expect(parsed!.callToAction).toBe(FULL_UNIT.callToAction);
  });

  it('returns undefined when [TOPIC] is missing', () => {
    const md = '[THESIS]\njust a thesis without a topic';
    expect(parseCanonicalUnit(md)).toBeUndefined();
  });

  it('returns undefined when [THESIS] is missing', () => {
    const md = '[TOPIC]\njust a topic without a thesis';
    expect(parseCanonicalUnit(md)).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(parseCanonicalUnit('')).toBeUndefined();
  });

  it('accepts Data hook label as alias for Data/Impact', () => {
    const md = [
      '[TOPIC]',
      'test topic',
      '[THESIS]',
      'test thesis',
      'HOOKS',
      '3. Data: some data point',
    ].join('\n');
    const parsed = parseCanonicalUnit(md);
    expect(parsed).toBeDefined();
    expect(parsed!.hooks.dataImpact).toBe('some data point');
  });

  it('parses core points from bullets or dashes', () => {
    const md = [
      '[TOPIC]',
      'topic',
      '[THESIS]',
      'thesis',
      'CORE POINTS',
      '- point one',
      '- point two',
    ].join('\n');
    const parsed = parseCanonicalUnit(md);
    expect(parsed!.corePoints).toEqual(['point one', 'point two']);
  });

  it('returns empty strings for missing optional brick sections', () => {
    const md = ['[TOPIC]', 'topic', '[THESIS]', 'thesis'].join('\n');
    const parsed = parseCanonicalUnit(md);
    expect(parsed).toBeDefined();
    expect(parsed!.shortFormBrick).toBe('');
    expect(parsed!.mediumFormBrick).toBe('');
    expect(parsed!.visualScriptBrick).toBe('');
    expect(parsed!.callToAction).toBe('');
  });
});

describe('wrapPostMarkdown / unwrapPostMarkdown', () => {
  it('wraps canonical + repurposed caption with HTML comment delimiters', () => {
    const canonical = renderCanonicalUnit(FULL_UNIT);
    const caption = 'R — Your Gentle AI Companion\n\nFinal Instagram caption here.';
    const wrapped = wrapPostMarkdown(canonical, caption);

    expect(wrapped).toContain(sectionOpen(CANONICAL_UNIT_SECTION));
    expect(wrapped).toContain(sectionClose(CANONICAL_UNIT_SECTION));
    expect(wrapped).toContain(sectionOpen(REPURPOSED_CAPTION_SECTION));
    expect(wrapped).toContain(sectionClose(REPURPOSED_CAPTION_SECTION));
  });

  it('omits the repurposed-caption block when caption is absent', () => {
    const canonical = renderCanonicalUnit(FULL_UNIT);
    const wrapped = wrapPostMarkdown(canonical, undefined);
    expect(wrapped).toContain(sectionOpen(CANONICAL_UNIT_SECTION));
    expect(wrapped).not.toContain(sectionOpen(REPURPOSED_CAPTION_SECTION));
  });

  it('omits the repurposed-caption block when caption is whitespace only', () => {
    const canonical = renderCanonicalUnit(FULL_UNIT);
    const wrapped = wrapPostMarkdown(canonical, '   \n  ');
    expect(wrapped).not.toContain(sectionOpen(REPURPOSED_CAPTION_SECTION));
  });

  it('round-trips canonical + caption through wrap → unwrap', () => {
    const canonical = renderCanonicalUnit(FULL_UNIT);
    const caption = 'Caption body here.';
    const wrapped = wrapPostMarkdown(canonical, caption);
    const unwrapped = unwrapPostMarkdown(wrapped);
    expect(unwrapped.canonicalMarkdown).toBe(canonical);
    expect(unwrapped.repurposedCaption).toBe(caption);
  });

  it('falls back to whole markdown as caption when no delimiters present (legacy)', () => {
    // Legacy posts predate the canonical contract and are plain captions.
    // The whole file must be treated as the caption (consistent with the
    // client reader), never mislabeled as a canonical unit.
    const legacy = 'Just a plain Instagram caption from before the canonical contract.';
    const unwrapped = unwrapPostMarkdown(legacy);
    expect(unwrapped.canonicalMarkdown).toBeUndefined();
    expect(unwrapped.repurposedCaption).toBe(legacy);
  });
});
