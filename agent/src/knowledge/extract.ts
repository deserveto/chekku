import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { KnowledgeDocumentKind } from '@chekku/storage';

/**
 * Server-side text extraction for Knowledge Base ingestion.
 *
 * - `text` kinds: UTF-8 decode with replacement (never throws on bad bytes).
 * - `pdf`: per-page text extraction via pdfjs-dist's legacy Node build — the
 *   same library the client already uses for page rendering, so no new PDF
 *   stack enters the repo. Text extraction needs no canvas or font assets.
 *
 * Images are deliberately unsupported: they stay in the multimodal chat path
 * and are never OCR-ed into the Knowledge Base.
 */

/** Hard cap on normalized extraction output; larger documents are truncated. */
export const MAX_EXTRACTED_CHARS = 2_000_000;

export interface ExtractedDocument {
  text: string;
  /** True when content beyond {@link MAX_EXTRACTED_CHARS} was dropped. */
  truncated: boolean;
}

export interface ExtractDocumentInput {
  kind: KnowledgeDocumentKind;
  bytes: Uint8Array;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

function extractTextBytes(bytes: Uint8Array): ExtractedDocument {
  let text = decoder.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  if (text.length > MAX_EXTRACTED_CHARS) {
    return { text: text.slice(0, MAX_EXTRACTED_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

async function extractPdfText(bytes: Uint8Array): Promise<ExtractedDocument> {
  // pdfjs may detach the passed buffer; hand it a private copy. The legacy
  // build runs on plain Node (no DOM, no worker) for text-only extraction.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const pageTexts: string[] = [];
  let totalChars = 0;
  let truncated = false;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      const textItem = item as PdfTextItem;
      if (typeof textItem.str !== 'string') continue;
      pageText += textItem.str;
      if (textItem.hasEOL === true) pageText += '\n';
    }
    page.cleanup();
    pageText = pageText.trim();
    if (pageText.length === 0) continue;
    if (totalChars + pageText.length > MAX_EXTRACTED_CHARS) {
      pageTexts.push(pageText.slice(0, MAX_EXTRACTED_CHARS - totalChars));
      totalChars = MAX_EXTRACTED_CHARS;
      truncated = true;
      break;
    }
    pageTexts.push(pageText);
    totalChars += pageText.length;
  }
  // Aborts the worker and frees the parsed document.
  await loadingTask.destroy();

  const text = pageTexts.join('\n\n');
  if (text.trim().length === 0) {
    throw new Error('No extractable text found in this PDF. Scanned image-only PDFs are not supported.');
  }
  return { text, truncated };
}

/**
 * Extract normalized text for one uploaded document. Throws a fixed,
 * user-actionable error when no text can be recovered; the ingestion pipeline
 * turns that into a `failed` document.
 */
export async function extractDocumentText(input: ExtractDocumentInput): Promise<ExtractedDocument> {
  if (input.bytes.byteLength === 0) {
    throw new Error('The uploaded document is empty.');
  }
  if (input.kind === 'pdf') {
    return extractPdfText(input.bytes);
  }
  return extractTextBytes(input.bytes);
}

/**
 * Normalization shared by every extraction path: strip BOM, collapse
 * carriage returns, and trim. Applied after {@link extractDocumentText} so
 * the persisted `extracted.txt` and the chunker see identical bytes.
 */
export function normalizeExtractedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}
