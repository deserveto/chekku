import { describe, expect, it } from 'vitest';

import { normalizeWin32Specifier } from './win-esm-specifier-hook.mjs';

describe('normalizeWin32Specifier', () => {
  it('repairs the exact backslashed specifier mastra dev emits on win32', () => {
    expect(normalizeWin32Specifier('pdfjs-dist\\legacy\\build\\pdf.mjs')).toBe(
      'pdfjs-dist/legacy/build/pdf.mjs',
    );
  });

  it('converts absolute Windows paths to file URLs', () => {
    expect(normalizeWin32Specifier('C:\\dev\\chekku\\agent\\.mastra\\output\\index.mjs')).toBe(
      'file:///C:/dev/chekku/agent/.mastra/output/index.mjs',
    );
  });

  it('leaves clean specifiers byte-identical', () => {
    for (const specifier of [
      'pdfjs-dist/legacy/build/pdf.mjs',
      '@mastra/core/workflows',
      'node:fs',
      './extract.js',
      'data:text/plain,hi',
    ]) {
      expect(normalizeWin32Specifier(specifier)).toBe(specifier);
    }
  });
});
