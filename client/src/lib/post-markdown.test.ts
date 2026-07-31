import { describe, expect, it } from 'vitest';

import { splitPostMarkdown } from './post-markdown';

describe('splitPostMarkdown', () => {
  it('extracts both the canonical unit and the repurposed caption', () => {
    const postMarkdown = [
      '<!-- canonical-unit -->',
      '[TOPIC]',
      'Meeting Fatigue',
      '<!-- /canonical-unit -->',
      '<!-- repurposed-caption -->',
      'R — Your Gentle AI Companion',
      '',
      'Final Instagram caption.',
      '<!-- /repurposed-caption -->',
    ].join('\n');

    const result = splitPostMarkdown(postMarkdown);
    expect(result.canonicalMarkdown).toContain('[TOPIC]');
    expect(result.canonicalMarkdown).toContain('Meeting Fatigue');
    expect(result.captionMarkdown).toContain('R — Your Gentle AI Companion');
    expect(result.captionMarkdown).toContain('Final Instagram caption.');
  });

  it('returns empty caption when only the canonical block is present', () => {
    const postMarkdown = [
      '<!-- canonical-unit -->',
      '[TOPIC]',
      'Solo canonical, no caption yet.',
      '<!-- /canonical-unit -->',
    ].join('\n');

    const result = splitPostMarkdown(postMarkdown);
    expect(result.canonicalMarkdown).toContain('Solo canonical');
    expect(result.captionMarkdown).toBe('');
  });

  it('treats delimiter-less legacy posts as a caption (never as canonical)', () => {
    // Pre-contract posts are plain captions. The whole file must come back as
    // the caption with no canonical section — consistent with the agent-side
    // `unwrapPostMarkdown` legacy fallback.
    const legacy = 'Just a plain Instagram caption from before the canonical contract.';
    const result = splitPostMarkdown(legacy);
    expect(result.canonicalMarkdown).toBeUndefined();
    expect(result.captionMarkdown).toBe(legacy);
  });

  it('tolerates extra whitespace inside the HTML comment delimiters', () => {
    const postMarkdown = [
      '<!--   canonical-unit   -->',
      '[TOPIC]',
      'Whitespace-tolerant topic.',
      '<!--   /canonical-unit   -->',
      '<!--repurposed-caption-->',
      'Caption body.',
      '<!--/repurposed-caption-->',
    ].join('\n');

    const result = splitPostMarkdown(postMarkdown);
    expect(result.canonicalMarkdown).toContain('Whitespace-tolerant topic.');
    expect(result.captionMarkdown).toBe('Caption body.');
  });
});
