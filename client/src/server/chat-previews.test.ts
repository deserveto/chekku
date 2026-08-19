import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { __testing, ChatPreviewError } from './chat-previews';

const { parseFile } = __testing;

describe('parseFile (chat-previews seam)', () => {
  it('builds the namespaced object key + content type for a valid preview file', () => {
    expect(parseFile('prev_20260808120000_abcd1234.png')).toEqual({
      objectKey: 'chat-previews/prev_20260808120000_abcd1234.png',
      contentType: 'image/png',
    });
    expect(parseFile('prev_20260808120000_abcd1234.jpeg').contentType).toBe('image/jpeg');
    expect(parseFile('prev_20260808120000_abcd1234.webp').contentType).toBe('image/webp');
  });

  it('rejects malformed preview ids', () => {
    expect(() => parseFile('not-a-preview.png')).toThrow(ChatPreviewError);
    expect(() => parseFile('smp_20260808120000_abcd1234.png')).toThrow(ChatPreviewError);
  });

  it('rejects disallowed extensions and path traversal', () => {
    expect(() => parseFile('prev_20260808120000_abcd1234.gif')).toThrow(ChatPreviewError);
    expect(() => parseFile('prev_20260808120000_abcd1234')).toThrow(ChatPreviewError);
    // No `..` / slashes accepted: a file segment with a slash fails the id regex
    // or the extension lookup.
    expect(() => parseFile('../prev_20260808120000_abcd1234.png')).toThrow(ChatPreviewError);
  });
});
