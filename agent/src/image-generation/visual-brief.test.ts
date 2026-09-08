import { describe, expect, it } from 'vitest';

import { FACTS_SCHEMA, IMAGE_PROMPT_SCHEMA, VISUAL_BRIEF_SCHEMA } from './visual-brief.js';

/**
 * Minimal valid brief: only the fields without defaults. `logoPosition` is
 * omitted on purpose — the schema defaults it to `bottom-right`.
 */
function makeBrief(overrides: Partial<{
  contentPillar: 'CELEBRATION' | 'TECHNOLOGY' | 'GENERAL';
  imagePrompt: string;
  headline: string;
  facts: string[];
  source: string;
}> = {}) {
  return {
    contentPillar: 'GENERAL',
    imagePrompt: 'wide-angle interior of a modern data center, cinematic, realistic, no text',
    headline: 'AI Factory di Batam',
    facts: ['Kapasitas 170.000 AI accelerators'],
    source: '',
    ...overrides,
  };
}

describe('FACTS_SCHEMA boundaries', () => {
  it('rejects zero entries', () => {
    expect(FACTS_SCHEMA.safeParse([]).success).toBe(false);
  });

  it('accepts exactly one entry', () => {
    expect(FACTS_SCHEMA.safeParse(['Kapasitas 170.000 AI accelerators']).success).toBe(true);
  });

  it('accepts exactly three entries', () => {
    expect(FACTS_SCHEMA.safeParse([
      'Kapasitas 170.000 AI accelerators',
      'Skala 360 MW',
      'Target operasional Q1 2027',
    ]).success).toBe(true);
  });

  it('rejects four entries', () => {
    expect(FACTS_SCHEMA.safeParse([
      'Kapasitas 170.000 AI accelerators',
      'Skala 360 MW',
      'Target operasional Q1 2027',
      'Fakta keempat',
    ]).success).toBe(false);
  });

  it('accepts an 80-character entry and rejects an 81-character entry', () => {
    expect(FACTS_SCHEMA.safeParse(['a'.repeat(80)]).success).toBe(true);
    expect(FACTS_SCHEMA.safeParse(['a'.repeat(81)]).success).toBe(false);
  });
});

describe('IMAGE_PROMPT_SCHEMA byte cap', () => {
  it('accepts exactly 2,000 UTF-8 bytes', () => {
    expect(IMAGE_PROMPT_SCHEMA.safeParse('x'.repeat(2_000)).success).toBe(true);
  });

  it('rejects 2,001 UTF-8 bytes', () => {
    expect(IMAGE_PROMPT_SCHEMA.safeParse('x'.repeat(2_001)).success).toBe(false);
  });

  it('counts non-ASCII characters by bytes, not by code units', () => {
    // é encodes to 2 UTF-8 bytes: 1,000 é = exactly 2,000 bytes.
    expect(IMAGE_PROMPT_SCHEMA.safeParse('é'.repeat(1_000)).success).toBe(true);
    // 1,001 é is only 1,001 characters but 2,002 bytes — over the cap.
    expect(IMAGE_PROMPT_SCHEMA.safeParse('é'.repeat(1_001)).success).toBe(false);
    // あ encodes to 3 UTF-8 bytes: 667 あ is 667 characters but 2,001 bytes.
    expect(IMAGE_PROMPT_SCHEMA.safeParse('あ'.repeat(667)).success).toBe(false);
  });
});

describe('VISUAL_BRIEF_SCHEMA', () => {
  it('accepts a minimal valid brief', () => {
    const result = VISUAL_BRIEF_SCHEMA.safeParse(makeBrief());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logoPosition).toBe('bottom-right');
    }
  });

  it('rejects a brief whose imagePrompt exceeds the 2,000 UTF-8 byte cap', () => {
    expect(VISUAL_BRIEF_SCHEMA.safeParse(makeBrief({ imagePrompt: 'x'.repeat(2_001) })).success).toBe(false);
    // Non-ASCII payload: 1,001 é chars (2,002 bytes) also rejects despite the
    // short string length.
    expect(VISUAL_BRIEF_SCHEMA.safeParse(makeBrief({ imagePrompt: 'é'.repeat(1_001) })).success).toBe(false);
  });
});
