import { describe, expect, it } from 'vitest';

import {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkText,
} from './chunk.js';

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short document as one deterministic chunk', () => {
    const text = 'Paragraf satu.\n\nParagraf dua.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toContain('Paragraf satu.');
    expect(chunks[0].text).toContain('Paragraf dua.');
    expect(chunkText(text)).toEqual(chunks);
  });

  it('packs paragraphs up to the target and never exceeds the hard max', () => {
    const paragraph = 'Kalimat pengujian untuk batas ukuran. '.repeat(8); // ~300 chars
    const text = Array.from({ length: 12 }, () => paragraph).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS + CHUNK_OVERLAP_CHARS);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('splits oversized single-paragraph documents on sentence boundaries', () => {
    const sentence = 'Ini kalimat panjang nomor %d yang harus dipisahkan dengan rapi. ';
    const text = Array.from({ length: 60 }, (_, i) => sentence.replace('%d', String(i + 1))).join('');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS + CHUNK_OVERLAP_CHARS);
    }
    // Reconstructable content: every chunk index is sequential from 0.
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });

  it('carries overlap between consecutive chunks', () => {
    const paragraph = 'Isi paragraf berulang untuk overlap. '.repeat(10);
    const text = Array.from({ length: 8 }, () => paragraph).join('\n\n');
    const chunks = chunkText(text);
    if (chunks.length > 1) {
      const tail = chunks[0].text.slice(-CHUNK_OVERLAP_CHARS - 20);
      expect(chunks[1].text.startsWith(tail.slice(-CHUNK_OVERLAP_CHARS).split(' ')[1] ?? '')).toBe(true);
    }
  });

  it('merges a tiny trailing chunk instead of shipping a near-empty vector', () => {
    const big = 'Paragraf penuh. '.repeat(80); // > target
    const text = `${big}\n\nok`;
    const chunks = chunkText(text);
    const last = chunks[chunks.length - 1];
    expect(last.text.length).toBeGreaterThan(3);
  });

  it('keeps chunk sizes near the target for large documents', () => {
    const paragraph = 'Kalimat isi dokumen pengetahuan. '.repeat(6);
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const sizes = chunks.map((chunk) => chunk.text.length);
    const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    expect(average).toBeGreaterThan(CHUNK_TARGET_CHARS / 2);
    expect(average).toBeLessThan(CHUNK_HARD_MAX_CHARS + CHUNK_OVERLAP_CHARS);
  });
});
