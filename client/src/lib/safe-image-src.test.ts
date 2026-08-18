import { describe, expect, it } from 'vitest';

import { isSafeImageSrc } from './safe-image-src.js';

describe('isSafeImageSrc', () => {
  it('accepts http, https, same-origin path, and data URLs', () => {
    expect(isSafeImageSrc('http://example.com/a.png')).toBe(true);
    expect(isSafeImageSrc('https://example.com/a.png')).toBe(true);
    expect(isSafeImageSrc('/api/storage/social-posts/smp_1/visuals/sva_2')).toBe(true);
    expect(isSafeImageSrc('data:image/png;base64,iVBOR')).toBe(true);
  });

  it('rejects javascript and other non-allowlisted schemes', () => {
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
    expect(isSafeImageSrc('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeImageSrc('vbscript:x')).toBe(false);
    expect(isSafeImageSrc('ftp://example.com/a.png')).toBe(false);
    expect(isSafeImageSrc('')).toBe(false);
  });

  it('rejects protocol-relative and relative-prefixed trickery', () => {
    expect(isSafeImageSrc('//evil.example.com/a.png')).toBe(false);
    expect(isSafeImageSrc('javascript:/example.com')).toBe(false);
  });
});
