import { describe, expect, it } from 'vitest';

import { describeImageGenerationFailure, ImageGenerationClientError } from './errors.js';

describe('describeImageGenerationFailure', () => {
  it('maps an ImageGenerationClientError to its category', () => {
    expect(describeImageGenerationFailure(new ImageGenerationClientError('timeout'))).toBe(
      'category=timeout',
    );
    expect(describeImageGenerationFailure(new ImageGenerationClientError('configuration'))).toBe(
      'category=configuration',
    );
    expect(describeImageGenerationFailure(new ImageGenerationClientError('review-failed'))).toBe(
      'category=review-failed',
    );
  });

  it('falls back to "name: message" for a plain Error', () => {
    expect(describeImageGenerationFailure(new TypeError('bad input'))).toBe('TypeError: bad input');
  });

  it('falls back to String() for non-Error input', () => {
    expect(describeImageGenerationFailure('boom')).toBe('boom');
    expect(describeImageGenerationFailure(42)).toBe('42');
    expect(describeImageGenerationFailure(null)).toBe('null');
    expect(describeImageGenerationFailure(undefined)).toBe('undefined');
  });

  it('caps the output at 300 characters', () => {
    const longMessage = 'x'.repeat(5_000);
    expect(describeImageGenerationFailure(new Error(longMessage))).toHaveLength(300);
    // Non-Error strings are capped by the same bound.
    expect(describeImageGenerationFailure(longMessage)).toHaveLength(300);
  });
});
