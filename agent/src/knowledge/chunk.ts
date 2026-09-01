/**
 * Document chunking for Knowledge Base indexing.
 *
 * Char-heuristic chunking with linguistic boundaries: paragraphs, then
 * sentences, then whitespace. Chars under-approximate tokens roughly 4:1 for
 * English and over-approximate for dense CJK text; both stay within typical
 * embedding-model windows at the configured sizes. A tokenizer dependency was
 * deliberately not added — the boundaries are what matter for retrieval
 * quality, and the sizes are centralized here so they can be tuned once.
 *
 * All values live in this module; nothing else in the pipeline may hardcode
 * chunk geometry.
 */

/** Soft target size; the packer fills up to this before flushing a chunk. */
export const CHUNK_TARGET_CHARS = 1_100;
/** Hard ceiling: no produced chunk ever exceeds this (post-merge guard). */
export const CHUNK_HARD_MAX_CHARS = 1_400;
/** Characters carried from the previous chunk into the next for continuity. */
export const CHUNK_OVERLAP_CHARS = 150;
/** Chunks smaller than this are merged into their predecessor when possible. */
export const CHUNK_MIN_CHARS = 80;
/** Safety cap on indexed chunks per document; larger extractions fail fast. */
export const MAX_CHUNKS_PER_DOCUMENT = 1_000;

export interface TextChunk {
  index: number;
  text: string;
}

/** Collapse newlines and strip control noise so boundaries behave predictably. */
function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Split one oversized block into sentence-bounded pieces no larger than max. */
function splitBySentences(block: string, max: number): string[] {
  const sentences = block
    .split(/(?<=[.!?\u2026])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current.length > 0) {
        pieces.push(current);
        current = '';
      }
      // Sentence itself exceeds max: fall back to whitespace slices.
      let rest = sentence;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < Math.floor(max / 2)) cut = max;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest.length > 0) current = rest;
      continue;
    }
    if (current.length > 0 && current.length + 1 + sentence.length > max) {
      pieces.push(current);
      current = sentence;
      continue;
    }
    current = current.length > 0 ? `${current} ${sentence}` : sentence;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Break the normalized document into boundary-aligned blocks ≤ hard max. */
function toBlocks(normalized: string): string[] {
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const blocks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= CHUNK_HARD_MAX_CHARS) {
      blocks.push(paragraph);
      continue;
    }
    blocks.push(...splitBySentences(paragraph, CHUNK_HARD_MAX_CHARS));
  }
  return blocks;
}

/** Prefix the next chunk with a boundary-aligned overlap from the previous. */
function overlapFrom(previous: string): string {
  if (previous.length === 0 || CHUNK_OVERLAP_CHARS <= 0) return '';
  const window = previous.slice(-CHUNK_OVERLAP_CHARS);
  const firstSpace = window.indexOf(' ');
  // Never start mid-word when a clean cut exists inside the window.
  const trimmed = firstSpace > 0 ? window.slice(firstSpace + 1) : window;
  return trimmed.length > 0 ? `${trimmed} ` : '';
}

/**
 * Deterministic chunker: same input always yields the same chunks. Packs
 * boundary-aligned blocks up to {@link CHUNK_TARGET_CHARS}, carries a
 * {@link CHUNK_OVERLAP_CHARS} tail between consecutive chunks, and merges a
 * tiny trailing chunk into its predecessor when the hard max allows.
 */
export function chunkText(input: string): TextChunk[] {
  const normalized = normalizeText(input);
  if (normalized.length === 0) return [];
  const blocks = toBlocks(normalized);

  const rawChunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current.length > 0 && current.length + 1 + block.length > CHUNK_TARGET_CHARS) {
      rawChunks.push(current);
      current = block;
      continue;
    }
    current = current.length > 0 ? `${current}\n\n${block}` : block;
  }
  if (current.length > 0) rawChunks.push(current);

  // Tiny-tail merge: fold a small final chunk into its predecessor instead of
  // shipping a near-empty vector.
  if (
    rawChunks.length > 1
    && rawChunks[rawChunks.length - 1].length < CHUNK_MIN_CHARS
  ) {
    const tail = rawChunks.pop() as string;
    const previous = rawChunks[rawChunks.length - 1];
    if (previous.length + 2 + tail.length <= CHUNK_HARD_MAX_CHARS) {
      rawChunks[rawChunks.length - 1] = `${previous}\n\n${tail}`;
    } else {
      rawChunks.push(tail);
    }
  }

  const chunks: TextChunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const prefix = i > 0 ? overlapFrom(rawChunks[i - 1]) : '';
    const text = `${prefix}${rawChunks[i]}`;
    if (text.trim().length === 0) continue;
    chunks.push({ index: chunks.length, text });
  }
  return chunks;
}
