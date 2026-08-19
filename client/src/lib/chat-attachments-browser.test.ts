// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { browserImageDeps, bytesToBase64 } from './chat-attachments-browser';

describe('bytesToBase64', () => {
  it('encodes empty and small byte arrays', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD');
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('encodes across chunk boundaries without argument-limit failures', () => {
    // Larger than the 0x8000 chunk size; the chunked loop must handle it
    // where a single String.fromCharCode(...bytes) spread would throw.
    const bytes = new Uint8Array(0x8000 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const encoded = bytesToBase64(bytes);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    // Round-trip through atob to prove no bytes were dropped.
    const decoded = atob(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(bytes.length - 1)).toBe((bytes.length - 1) % 251);
  });
});

describe('browserImageDeps', () => {
  it('reads Blob bytes and base64-encodes them round-trip', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 250])], {
      type: 'image/png',
    });
    const bytes = await browserImageDeps.readBytes(blob);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 250]);
    expect(browserImageDeps.base64Encode(bytes)).toBe(bytesToBase64(bytes));
    expect(atob(browserImageDeps.base64Encode(bytes))).toHaveLength(4);
  });

  it('creates a canvas element with the requested dimensions', () => {
    const canvas = browserImageDeps.createCanvas(12, 34);
    expect(canvas.width).toBe(12);
    expect(canvas.height).toBe(34);
  });
});
