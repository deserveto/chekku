import {
  beginKnowledgeDocumentIngestion,
  completeKnowledgeDocumentIngestion,
  createLazyGarageObjectStorage,
  failKnowledgeDocumentIngestion,
  getKnowledgeDocument,
  knowledgeDocumentKeys,
  readKnowledgeDocumentOriginalBytes,
  type ObjectStorage,
  ObjectStorageError,
} from '@chekku/storage';

import { chunkText, MAX_CHUNKS_PER_DOCUMENT } from './chunk.js';
import { EmbeddingsError, createEmbeddingsClient, type EmbeddingsClient } from './embeddings.js';
import { extractDocumentText, normalizeExtractedText } from './extract.js';
import {
  KnowledgeIndexError,
  createQdrantKnowledgeIndex,
  type KnowledgeVectorIndex,
} from './qdrant-index.js';

/**
 * Knowledge Base ingestion pipeline (agent-side, server-owned).
 *
 * Runs inside the `knowledge-document-ingestion` Mastra workflow, fired
 * fire-and-forget by the Next.js upload route AFTER the raw document and its
 * `processing` metadata record are durably persisted. Every step is
 * idempotent: a retry re-begins from `processing`, wipes any partial vectors
 * for the document before upserting, and writes the terminal metadata
 * transition last — so a crashed run never leaves duplicate vectors or a
 * `ready` record without an index.
 *
 * Failure contract: the raw document is always preserved; the metadata
 * record ends in `failed` with a fixed bounded reason; partial Qdrant data
 * for the document is deleted best-effort before giving up.
 */

export interface KnowledgeIngestionResult {
  ok: boolean;
  documentId: string;
  resourceId: string;
  chunkCount?: number;
  error?: string;
}

export interface KnowledgeIngestionDeps {
  storeFactory?: () => ObjectStorage;
  indexFactory?: () => KnowledgeVectorIndex;
  embeddingsFactory?: () => EmbeddingsClient;
  extract?: typeof extractDocumentText;
  now?: () => Date;
}

/** Fixed, bounded failure reasons safe to show in the UI. */
const FIXED_ERRORS = {
  notFound: 'This document no longer exists in your Knowledge.',
  storageUnavailable: 'Knowledge storage is currently unavailable. Try again shortly.',
  unconfigured: 'Knowledge indexing is not configured on this server. Set QDRANT_URL and LLM_EMBEDDING_MODEL.',
  empty: 'No extractable text found in this document.',
  tooLarge: 'This document is too large to index.',
  embedFailed: 'The embedding model request failed.',
  indexFailed: 'The knowledge index rejected the update.',
} as const;

function sanitizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  return singleLine.length > 200 ? `${singleLine.slice(0, 199)}…` : singleLine;
}

function fixedReason(error: unknown): string {
  if (error instanceof EmbeddingsError) {
    if (error.code === 'configuration') return FIXED_ERRORS.unconfigured;
    if (error.code === 'timeout' || error.code === 'unavailable' || error.code === 'format') {
      return FIXED_ERRORS.embedFailed;
    }
  }
  if (error instanceof KnowledgeIndexError) {
    if (error.code === 'configuration') return FIXED_ERRORS.unconfigured;
    if (error.code === 'incompatible') return sanitizeReason(error);
    return FIXED_ERRORS.indexFailed;
  }
  return sanitizeReason(error);
}

/**
 * Run one document through extraction → chunking → embedding → indexing.
 * Never throws: every failure path resolves with a result so the wrapping
 * workflow stays terminal-state clean.
 */
export async function runKnowledgeIngestion(
  input: { documentId: string; resourceId: string },
  deps: KnowledgeIngestionDeps = {},
): Promise<KnowledgeIngestionResult> {
  const store = (deps.storeFactory ?? createLazyGarageObjectStorage)();
  const now = deps.now;
  // existence + ownership gate: a wrong pair collapses to not-found here.
  // Any other storage error is an outage, not a missing document — report it
  // as such and leave the record untouched (a retry is expected to work).
  let document;
  try {
    document = (await getKnowledgeDocument(store, input.resourceId, input.documentId)).metadata;
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code !== 'not-found') {
      return {
        ok: false,
        documentId: input.documentId,
        resourceId: input.resourceId,
        error: FIXED_ERRORS.storageUnavailable,
      };
    }
    return {
      ok: false,
      documentId: input.documentId,
      resourceId: input.resourceId,
      error: FIXED_ERRORS.notFound,
    };
  }

  let index: KnowledgeVectorIndex;
  let embeddings: EmbeddingsClient;
  try {
    index = deps.indexFactory?.() ?? createQdrantKnowledgeIndex();
    embeddings = deps.embeddingsFactory?.() ?? createEmbeddingsClient();
  } catch (error) {
    const reason = fixedReason(error);
    await failKnowledgeDocumentIngestion(store, input.resourceId, input.documentId, reason, { now });
    return { ok: false, documentId: input.documentId, resourceId: input.resourceId, error: reason };
  }

  // Fixed-code logging: error objects can carry provider messages, so only
  // their bounded class/code reaches the log line.
  const logCode = (error: unknown): string => {
    if (error instanceof KnowledgeIndexError) return error.code;
    if (error instanceof ObjectStorageError) return error.code;
    if (error instanceof Error) return error.name;
    return 'unknown';
  };

  const cleanupVectors = async (): Promise<void> => {
    try {
      await index.deleteDocumentPoints(input.resourceId, input.documentId);
    } catch (cleanupError) {
      console.error('[knowledge-ingestion] vector cleanup failed:', logCode(cleanupError));
    }
  };

  // `begin` is the mutual-exclusion gate: when it throws, another run owns
  // the document (fresh `processing`, or `ready` already indexed). The loser
  // must leave quietly — no vector cleanup, no status overwrite — or it
  // would destroy the winner's healthy index (review P1).
  let begun = false;
  try {
    await beginKnowledgeDocumentIngestion(store, input.resourceId, input.documentId, { now });
    begun = true;

    const original = await readKnowledgeDocumentOriginalBytes(store, input.resourceId, input.documentId);
    const extracted = await (deps.extract ?? extractDocumentText)({
      kind: document.kind,
      bytes: original.value,
    });
    const normalized = normalizeExtractedText(extracted.text);
    if (normalized.length === 0) {
      throw new Error(FIXED_ERRORS.empty);
    }

    // Body first, metadata transition last — the extracted representation is
    // an optimization for inspection, never required for retrieval. The
    // Garage adapter's replace is conditional on existence, so first ingestion
    // creates and retries overwrite (idempotent across crashed runs).
    const { extractedObjectKey } = knowledgeDocumentKeys(input.resourceId, input.documentId);
    try {
      await store.createText(extractedObjectKey, normalized, 'text/plain; charset=utf-8');
    } catch (error) {
      if (!(error instanceof ObjectStorageError && error.code === 'already-exists')) throw error;
      await store.replaceText(extractedObjectKey, normalized, 'text/plain; charset=utf-8');
    }

    const chunks = chunkText(normalized);
    if (chunks.length === 0) {
      throw new Error(FIXED_ERRORS.empty);
    }
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(FIXED_ERRORS.tooLarge);
    }

    // Embed everything first so a gateway failure cannot leave partial vectors.
    let vectors: number[][];
    try {
      vectors = await embeddings.embed(chunks.map((chunk) => chunk.text));
    } catch (error) {
      if (error instanceof EmbeddingsError) throw error;
      throw new EmbeddingsError('unavailable', FIXED_ERRORS.embedFailed);
    }
    if (vectors.length !== chunks.length) {
      throw new Error(FIXED_ERRORS.embedFailed);
    }

    await index.ensureCollection(vectors[0].length);
    // Delete-before-upsert: retries and re-runs never duplicate vectors.
    await index.deleteDocumentPoints(input.resourceId, input.documentId);
    await index.upsertPoints(chunks.map((chunk, position) => ({
      vector: vectors[position],
      payload: {
        resourceId: input.resourceId,
        documentId: input.documentId,
        filename: document.filename,
        chunkIndex: chunk.index,
        text: chunk.text,
        mimeType: document.mimeType,
        ...(document.sourceThreadId !== undefined ? { sourceThreadId: document.sourceThreadId } : {}),
        embeddingModel: embeddings.model,
      },
    })));

    const metadata = await completeKnowledgeDocumentIngestion(
      store,
      input.resourceId,
      input.documentId,
      { chunkCount: chunks.length, embeddingModel: embeddings.model },
      { now },
    );
    return {
      ok: true,
      documentId: input.documentId,
      resourceId: input.resourceId,
      chunkCount: metadata.chunkCount,
    };
  } catch (error) {
    if (!begun) {
      // Lost the begin race (or the record vanished): the winner — or
      // nobody — owns the document. Never touch its vectors or status.
      return {
        ok: false,
        documentId: input.documentId,
        resourceId: input.resourceId,
        error: fixedReason(error),
      };
    }
    await cleanupVectors();
    const reason = fixedReason(error);
    try {
      await failKnowledgeDocumentIngestion(store, input.resourceId, input.documentId, reason, { now });
    } catch (metadataError) {
      console.error('[knowledge-ingestion] could not persist failure state:', logCode(metadataError));
    }
    return { ok: false, documentId: input.documentId, resourceId: input.resourceId, error: reason };
  }
}
