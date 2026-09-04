import { describe, expect, it, vi } from 'vitest';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { MAX_PDF_PAGES, extractDocumentText, extractPdfText, normalizeExtractedText } from './extract.js';

interface FakeLoadingTask {
  promise: Promise<{
    numPages: number;
    getPage: (pageNumber: number) => Promise<{
      getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      cleanup: () => void;
    }>;
  }>;
  destroy: () => Promise<void>;
}

function createFakeLoader(options: { numPages: number; failOnPage?: number }) {
  const destroy = vi.fn(async () => {});
  const pagesRequested: number[] = [];
  const load = vi.fn((): FakeLoadingTask => ({
    promise: Promise.resolve({
      numPages: options.numPages,
      getPage: async (pageNumber: number) => {
        pagesRequested.push(pageNumber);
        if (options.failOnPage === pageNumber) throw new Error('corrupt page');
        return {
          getTextContent: async () => ({ items: [{ str: `page-${pageNumber}`, hasEOL: true }] }),
          cleanup: () => {},
        };
      },
    }),
    destroy,
  }));
  return { load, destroy, pagesRequested };
}

const asGetDocument = (load: unknown) => load as unknown as typeof getDocument;

describe('knowledge document extraction', () => {
  it('extracts and normalizes text documents', async () => {
    const result = await extractDocumentText({
      kind: 'text',
      bytes: new TextEncoder().encode('\uFEFFAlpha\r\nBeta\u0000'),
    });
    expect(normalizeExtractedText(result.text)).toBe('Alpha\nBeta');
    expect(result.truncated).toBe(false);
  });

  it('destroys the parsed document even when a page throws', async () => {
    const { load, destroy } = createFakeLoader({ numPages: 3, failOnPage: 2 });
    await expect(
      extractPdfText(new Uint8Array([1]), asGetDocument(load)),
    ).rejects.toThrow('corrupt page');
    // The corrupt/encrypted-PDF path must not leak the parsed document.
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds parse work at MAX_PDF_PAGES and reports truncation', async () => {
    const { load, destroy, pagesRequested } = createFakeLoader({ numPages: MAX_PDF_PAGES + 50 });
    const result = await extractPdfText(new Uint8Array([1]), asGetDocument(load));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(`page-${MAX_PDF_PAGES}`);
    expect(result.text).not.toContain(`page-${MAX_PDF_PAGES + 1}`);
    expect(pagesRequested).toHaveLength(MAX_PDF_PAGES);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
