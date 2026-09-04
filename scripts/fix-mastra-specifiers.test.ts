import { describe, expect, it } from 'vitest';

import { rewriteSpecifiers } from './fix-mastra-specifiers.mjs';

describe('rewriteSpecifiers', () => {
  it('normalizes the exact backslashed static import emitted by mastra build on win32', () => {
    const broken = String.raw`import { getDocument } from 'pdfjs-dist\legacy\build\pdf.mjs';`;
    const { code, count } = rewriteSpecifiers(broken);
    expect(code).toBe(`import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';`);
    expect(count).toBe(1);
  });

  it('normalizes dynamic imports and export-from while preserving keyword spacing', () => {
    const broken = [
      String.raw`const m = await import('.\chunk-abc.mjs');`,
      String.raw`export * from 'some-pkg\sub\path.js';`,
    ].join('\n');
    const { code, count } = rewriteSpecifiers(broken);
    expect(code).toBe(
      [`const m = await import('./chunk-abc.mjs');`, `export * from 'some-pkg/sub/path.js';`].join('\n'),
    );
    expect(count).toBe(2);
  });

  it('normalizes side-effect imports and scoped packages', () => {
    const { code, count } = rewriteSpecifiers(String.raw`import '@scope\pkg\style.css';`);
    expect(code).toBe(`import '@scope/pkg/style.css';`);
    expect(count).toBe(1);
  });

  it('leaves clean output untouched (Linux bundles are a no-op)', () => {
    const clean = [
      `import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';`,
      `import { createWorkflow } from '@mastra/core/workflows';`,
      `const note = 'string with \\\\ backslash stays';`,
      String.raw`const re = /a\\b/;`,
    ].join('\n');
    const { code, count } = rewriteSpecifiers(clean);
    expect(code).toBe(clean);
    expect(count).toBe(0);
  });

  it('is idempotent', () => {
    const broken = String.raw`import { getDocument } from 'pdfjs-dist\legacy\build\pdf.mjs';`;
    const once = rewriteSpecifiers(broken);
    const twice = rewriteSpecifiers(once.code);
    expect(twice.code).toBe(once.code);
    expect(twice.count).toBe(0);
  });

  it('does not rewrite backslashes inside non-specifier strings', () => {
    const source = [
      String.raw`const winPath = 'C:\dev\chekku\agent';`,
      String.raw`const msg = "use \n carefully";`,
    ].join('\n');
    const { code, count } = rewriteSpecifiers(source);
    expect(code).toBe(source);
    expect(count).toBe(0);
  });
});
