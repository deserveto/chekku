import { randomBytes } from 'node:crypto';

import {
  asBinaryObjectStorage,
  ObjectStorageError,
  type ObjectStorage,
} from './objects.ts';

/**
 * Fixed Garage storage root for the per-user Knowledge Base. Documents live
 * under a bucket-root prefix (not the `agents/<agent-id>` namespaces used by
 * PM reports and social posts) because knowledge is owned by an authenticated
 * user, not by an agent:
 *
 *     kb/users/<resourceId>/documents/<documentId>/original.<ext>
 *     kb/users/<resourceId>/documents/<documentId>/extracted.txt
 *     kb/users/<resourceId>/documents/<documentId>/metadata.json
 *
 * `<resourceId>` is the Better Auth session user id — the same identity the
 * rest of Chekku uses for Memory thread ownership. It is strictly validated
 * before it may enter an object key so a hostile id can never escape the
 * prefix. Metadata is always written LAST so a partial save never becomes a
 * list entry, mirroring the pm-report and social-post repositories.
 */
export const KNOWLEDGE_STORAGE_ROOT = 'kb/users';

/** Canonical knowledge document id: `kbd_YYYYMMDDHHMMSS_<8 lowercase hex>`. */
export const KNOWLEDGE_DOCUMENT_ID_RE = /^kbd_[0-9]{14}_[0-9a-f]{8}$/;

/**
 * Resource ids accepted into object keys. Better Auth user ids are opaque
 * tokens; anything outside this conservative allowlist is rejected instead of
 * being encoded, so keys stay inspectable and path traversal is impossible.
 */
export const KNOWLEDGE_RESOURCE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Document lifecycle. `processing` covers the window between the upload
 * persisting the raw file and the agent-side ingestion workflow finishing;
 * a `processing` document whose `updatedAt` grows older than
 * {@link KNOWLEDGE_STALE_PROCESSING_MS} is treated as failed and may be
 * retried (e.g. after an agent-server restart killed the workflow).
 */
export type KnowledgeDocumentStatus = 'processing' | 'ready' | 'failed';

/**
 * Indexed document kinds. Images deliberately have no kind: they keep flowing
 * through the existing multimodal chat path and are never OCR-ed into the
 * Knowledge Base.
 */
export type KnowledgeDocumentKind = 'text' | 'pdf';

export interface KnowledgeDocumentMetadata {
  id: string;
  resourceId: string;
  filename: string;
  mimeType: string;
  kind: KnowledgeDocumentKind;
  sizeBytes: number;
  /** Relative Garage key of the original upload. */
  storageKey: string;
  /** Relative Garage key of the normalized extraction, once ingested. */
  extractedObjectKey?: string;
  status: KnowledgeDocumentStatus;
  chunkCount?: number;
  /** Chat thread the upload happened in, when known. */
  sourceThreadId?: string;
  /** Embedding model that produced the indexed vectors. */
  embeddingModel?: string;
  /** Fixed, bounded failure reason for the UI when status is `failed`. */
  error?: string;
  /** When the last accepted ingestion run claimed this document; absent
   * until a run passes `beginKnowledgeDocumentIngestion`. Drives the
   * mutual-exclusion freshness check. */
  ingestionStartedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Pure inputs for building a document's canonical metadata. */
export interface KnowledgeDocumentInput {
  resourceId: string;
  documentId?: string;
  filename: string;
  mimeType: string;
  kind: KnowledgeDocumentKind;
  sourceThreadId?: string;
  now?: () => Date;
}

export interface BuiltKnowledgeDocument {
  metadata: KnowledgeDocumentMetadata;
  metadataJson: string;
  documentId: string;
  originalObjectKey: string;
  extractedObjectKey: string;
  metadataObjectKey: string;
}

export interface KnowledgeDocumentReadResult {
  metadata: KnowledgeDocumentMetadata;
}

export interface KnowledgeDocumentBytes {
  value: Uint8Array;
  contentType: string;
}

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** Hard cap on stored filenames (already sanitized upstream; defense in depth). */
const MAX_FILENAME_CHARS = 200;

/**
 * Maximum documents one user may hold. Uploads are auto-created by every
 * chat text/PDF send, so an unbounded user could otherwise wedge listing
 * (each document costs multiple list + metadata reads) forever.
 */
export const MAX_KNOWLEDGE_DOCUMENTS_PER_USER = 500;

/** Listing window for one user's document keys (well past the cap above). */
const MAX_KNOWLEDGE_LISTING_KEYS = 10_000;

/** Concurrent metadata reads during listing — bounded, never one-per-key. */
const LISTING_CONCURRENCY = 8;

/** Hard cap on the persisted failure reason so metadata stays bounded. */
const MAX_ERROR_CHARS = 500;
const MAX_MIME_CHARS = 100;
const MAX_EMBEDDING_MODEL_CHARS = 200;
const MAX_SOURCE_THREAD_ID_CHARS = 256;

const STATUSES: readonly KnowledgeDocumentStatus[] = ['processing', 'ready', 'failed'];
const KINDS: readonly KnowledgeDocumentKind[] = ['text', 'pdf'];

const TEXT_EXTENSION_ALLOWED: Record<string, true> = {
  txt: true,
  md: true,
  csv: true,
  tsv: true,
  json: true,
  log: true,
  xml: true,
  yml: true,
  yaml: true,
};

/**
 * A `processing` document older than this is considered abandoned by a dead
 * run and becomes retryable. Generous on purpose: ingestion is normally
 * seconds, but embedding a large PDF can legitimately take a minute or two.
 */
export const KNOWLEDGE_STALE_PROCESSING_MS = 15 * 60 * 1000;

export function createKnowledgeDocumentId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `kbd_${stamp}_${randomBytes(4).toString('hex')}`;
}

/**
 * Validate a resource id for key construction. Exported because both the
 * storage helpers and the Next.js service must apply the identical gate.
 */
export function validateKnowledgeResourceId(resourceId: string): string {
  if (!KNOWLEDGE_RESOURCE_ID_RE.test(resourceId)) {
    throw new ObjectStorageError(
      'configuration',
      'Invalid resource id for knowledge storage.',
    );
  }
  return resourceId;
}

export function knowledgeDocumentKeys(resourceId: string, documentId: string): {
  basePrefix: string;
  originalObjectKey: string;
  extractedObjectKey: string;
  metadataObjectKey: string;
} {
  validateKnowledgeResourceId(resourceId);
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(documentId)) {
    throw new ObjectStorageError('configuration', `Invalid knowledge document id: ${documentId}`);
  }
  const basePrefix = `${KNOWLEDGE_STORAGE_ROOT}/${resourceId}/documents/${documentId}`;
  return {
    basePrefix,
    originalObjectKey: `${basePrefix}/original`,
    extractedObjectKey: `${basePrefix}/extracted.txt`,
    metadataObjectKey: `${basePrefix}/metadata.json`,
  };
}

function parseRfc3339Timestamp(value: string): number | undefined {
  if (!RFC3339_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Parse a knowledge document id timestamp (`kbd_YYYYMMDDHHMMSS_...`). */
export function parseKnowledgeDocumentTimestamp(value: string): number | undefined {
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(value)) return undefined;
  const stamp = value.slice(4, 18);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function isKnowledgeDocumentStatus(value: unknown): value is KnowledgeDocumentStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

function isKnowledgeDocumentKind(value: unknown): value is KnowledgeDocumentKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function optionalBoundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    return undefined;
  }
  return value;
}

/**
 * Resolve the original object's extension from the sanitized filename.
 * Only known-safe short alphanumeric extensions survive; anything else falls
 * back to the kind default, so the key can never carry injected characters.
 */
export function extensionForKnowledgeDocument(kind: KnowledgeDocumentKind, filename: string): string {
  if (kind === 'pdf') return 'pdf';
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename);
  const ext = match?.[1]?.toLowerCase();
  return ext !== undefined && TEXT_EXTENSION_ALLOWED[ext] === true ? ext : 'txt';
}

function parseKnowledgeDocumentMetadata(
  value: unknown,
  expected: { resourceId: string; documentId: string },
): KnowledgeDocumentMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  const resourceId = raw.resourceId;
  const filename = raw.filename;
  const mimeType = raw.mimeType;
  const kind = raw.kind;
  const sizeBytes = raw.sizeBytes;
  const storageKey = raw.storageKey;
  const status = raw.status;
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;

  if (typeof id !== 'string' || !KNOWLEDGE_DOCUMENT_ID_RE.test(id)) return undefined;
  if (id !== expected.documentId) return undefined;
  if (typeof resourceId !== 'string' || !KNOWLEDGE_RESOURCE_ID_RE.test(resourceId)) return undefined;
  if (resourceId !== expected.resourceId) return undefined;
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_FILENAME_CHARS) return undefined;
  if (typeof mimeType !== 'string' || mimeType.length === 0 || mimeType.length > MAX_MIME_CHARS) return undefined;
  if (!isKnowledgeDocumentKind(kind)) return undefined;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return undefined;
  if (!isKnowledgeDocumentStatus(status)) return undefined;
  if (typeof createdAt !== 'string' || parseRfc3339Timestamp(createdAt) === undefined) return undefined;
  if (typeof updatedAt !== 'string' || parseRfc3339Timestamp(updatedAt) === undefined) return undefined;

  const keys = knowledgeDocumentKeys(resourceId, id);
  if (typeof storageKey !== 'string') return undefined;
  if (!storageKey.startsWith(`${keys.basePrefix}/original.`)) return undefined;

  const extractedObjectKey = optionalBoundedString(raw.extractedObjectKey, keys.extractedObjectKey.length);
  if (raw.extractedObjectKey !== undefined && extractedObjectKey !== keys.extractedObjectKey) return undefined;

  const chunkCount = raw.chunkCount;
  if (chunkCount !== undefined && (typeof chunkCount !== 'number' || !Number.isSafeInteger(chunkCount) || chunkCount < 0)) {
    return undefined;
  }
  const embeddingModel = optionalBoundedString(raw.embeddingModel, MAX_EMBEDDING_MODEL_CHARS);
  if (raw.embeddingModel !== undefined && embeddingModel === undefined) return undefined;
  const sourceThreadId = optionalBoundedString(raw.sourceThreadId, MAX_SOURCE_THREAD_ID_CHARS);
  if (raw.sourceThreadId !== undefined && sourceThreadId === undefined) return undefined;
  const error = optionalBoundedString(raw.error, MAX_ERROR_CHARS);
  if (raw.error !== undefined && error === undefined) return undefined;
  const ingestionStartedAt = raw.ingestionStartedAt;
  if (ingestionStartedAt !== undefined
    && (typeof ingestionStartedAt !== 'string' || parseRfc3339Timestamp(ingestionStartedAt) === undefined)) {
    return undefined;
  }

  return {
    id,
    resourceId,
    filename,
    mimeType,
    kind,
    sizeBytes,
    storageKey,
    ...(extractedObjectKey !== undefined ? { extractedObjectKey } : {}),
    status,
    ...(chunkCount !== undefined ? { chunkCount } : {}),
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    ...(embeddingModel !== undefined ? { embeddingModel } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(ingestionStartedAt !== undefined ? { ingestionStartedAt } : {}),
    createdAt,
    updatedAt,
  };
}

/**
 * Pure builder for a document's canonical metadata + object keys. Nothing
 * here touches storage. The caller writes `original.<ext>` first and the
 * metadata object LAST, so a crashed upload never becomes a list entry.
 */
export function buildKnowledgeDocument(input: KnowledgeDocumentInput, bytes: Uint8Array): BuiltKnowledgeDocument {
  validateKnowledgeResourceId(input.resourceId);
  // Same convention as the client's sanitizeAttachmentFilename: control
  // characters (including newlines) never belong in metadata, Qdrant
  // payloads, or tool output. Idempotent — already-clean names pass through.
  const filename = typeof input.filename === 'string'
    ? input.filename.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : input.filename;
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_FILENAME_CHARS) {
    throw new Error('Knowledge document filename must be 1-200 characters.');
  }
  if (typeof input.mimeType !== 'string' || input.mimeType.length === 0 || input.mimeType.length > MAX_MIME_CHARS) {
    throw new Error('Knowledge document mimeType must be a non-empty string of at most 100 characters.');
  }
  if (!isKnowledgeDocumentKind(input.kind)) {
    throw new Error(`Unsupported knowledge document kind: ${String(input.kind)}`);
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('Knowledge document bytes must be non-empty.');
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const documentId = input.documentId ?? createKnowledgeDocumentId(new Date(createdAt));
  const keys = knowledgeDocumentKeys(input.resourceId, documentId);
  const ext = extensionForKnowledgeDocument(input.kind, filename);
  const originalObjectKey = `${keys.originalObjectKey}.${ext}`;
  const metadata: KnowledgeDocumentMetadata = {
    id: documentId,
    resourceId: input.resourceId,
    filename,
    mimeType: input.mimeType,
    kind: input.kind,
    sizeBytes: bytes.byteLength,
    storageKey: originalObjectKey,
    status: 'processing',
    ...(input.sourceThreadId !== undefined ? { sourceThreadId: input.sourceThreadId } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  return {
    metadata,
    metadataJson: JSON.stringify(metadata, null, 2),
    documentId,
    originalObjectKey,
    extractedObjectKey: keys.extractedObjectKey,
    metadataObjectKey: keys.metadataObjectKey,
  };
}

/**
 * Persist one uploaded document: original bytes first, metadata LAST.
 * Returns the stored metadata. Raises on storage failure — the caller maps
 * adapter errors to its own bounded service errors.
 */
export async function saveKnowledgeDocument(
  store: ObjectStorage,
  input: KnowledgeDocumentInput,
  bytes: Uint8Array,
): Promise<KnowledgeDocumentMetadata> {
  const built = buildKnowledgeDocument(input, bytes);
  const binary = asBinaryObjectStorage(store);
  await binary.createBytes(built.originalObjectKey, bytes, input.mimeType);
  await store.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
  return built.metadata;
}

/** Read + validate one listed metadata object. Returns undefined for corrupt,
 * noncanonical, or vanished entries — a listing never fails on one bad key. */
async function readListedDocument(
  store: ObjectStorage,
  key: string,
  prefix: string,
  resourceId: string,
): Promise<KnowledgeDocumentMetadata | undefined> {
  try {
    const metadataText = await store.getText(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(metadataText);
    } catch {
      return undefined;
    }
    const documentId = key.slice(prefix.length, -'/metadata.json'.length);
    const record = parseKnowledgeDocumentMetadata(parsed, { resourceId, documentId });
    if (record === undefined) return undefined;
    const canonical = knowledgeDocumentKeys(resourceId, documentId);
    return canonical.metadataObjectKey === key ? record : undefined;
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') return undefined;
    throw error;
  }
}

/**
 * List one user's knowledge documents, newest first. The listing prefix is
 * scoped to the resource id, and every parsed record must still re-declare
 * the same resourceId AND live at the canonical metadata key — two
 * independent isolation checks before a record can surface.
 */
export async function listKnowledgeDocuments(
  store: ObjectStorage,
  resourceId: string,
): Promise<KnowledgeDocumentMetadata[]> {
  validateKnowledgeResourceId(resourceId);
  const prefix = `${KNOWLEDGE_STORAGE_ROOT}/${resourceId}/documents/`;
  const result = await store.listKeys(prefix, { limit: MAX_KNOWLEDGE_LISTING_KEYS });
  if (result.truncated) {
    throw new ObjectStorageError(
      'unavailable',
      'Cannot list knowledge documents: storage truncated the listing.',
    );
  }
  const metadataKeys = result.keys.filter((key) => key.endsWith('/metadata.json'));
  // Bounded-concurrency map: never one in-flight read per document.
  const entries: Array<KnowledgeDocumentMetadata | undefined> = new Array(metadataKeys.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(LISTING_CONCURRENCY, metadataKeys.length) },
    async () => {
      while (cursor < metadataKeys.length) {
        const index = cursor++;
        entries[index] = await readListedDocument(store, metadataKeys[index], prefix, resourceId);
      }
    },
  );
  await Promise.all(workers);
  const documents = entries.filter((entry): entry is KnowledgeDocumentMetadata => entry !== undefined);
  return documents
    .map((doc, index) => ({ doc, index, timestamp: parseKnowledgeDocumentTimestamp(doc.id) }))
    .sort((a, b) => {
      if (a.timestamp === undefined && b.timestamp === undefined) return a.index - b.index;
      if (a.timestamp === undefined) return 1;
      if (b.timestamp === undefined) return -1;
      return b.timestamp - a.timestamp || a.index - b.index;
    })
    .map(({ doc }) => doc);
}

/**
 * Count one user's documents (metadata keys under their prefix). Used to
 * enforce {@link MAX_KNOWLEDGE_DOCUMENTS_PER_USER} before a save; key listing
 * only, so it stays cheap even at the cap.
 */
export async function countKnowledgeDocuments(
  store: ObjectStorage,
  resourceId: string,
): Promise<number> {
  validateKnowledgeResourceId(resourceId);
  const prefix = `${KNOWLEDGE_STORAGE_ROOT}/${resourceId}/documents/`;
  const result = await store.listKeys(prefix, { limit: MAX_KNOWLEDGE_LISTING_KEYS });
  return result.keys.filter((key) => key.endsWith('/metadata.json')).length;
}

/**
 * Load one document's metadata. The parsed record must match BOTH the
 * requested resourceId and documentId, so a foreign or forged id collapses
 * to `not-found` at the storage layer.
 */
export async function getKnowledgeDocument(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
): Promise<KnowledgeDocumentReadResult> {
  const record = await readMetadataRecord(store, resourceId, documentId);
  return { metadata: record };
}

/**
 * Per-document in-process serializer for metadata read-modify-writes, mirroring
 * the social-post repository. Cross-process writers remain subject to the
 * documented Garage v2.3 conditional-write limitation.
 */
const metadataWriteTails = new Map<string, Promise<void>>();

async function serializeMetadataWrite<T>(
  resourceId: string,
  documentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const tailKey = `${resourceId}/${documentId}`;
  const previous = metadataWriteTails.get(tailKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  metadataWriteTails.set(tailKey, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metadataWriteTails.get(tailKey) === current) metadataWriteTails.delete(tailKey);
  }
}

async function readMetadataRecord(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
): Promise<KnowledgeDocumentMetadata> {
  const keys = knowledgeDocumentKeys(resourceId, documentId);
  const metadataText = await store.getText(keys.metadataObjectKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataText);
  } catch {
    throw new ObjectStorageError('not-found', `Knowledge document not found: ${documentId}`);
  }
  const record = parseKnowledgeDocumentMetadata(parsed, { resourceId, documentId });
  if (record === undefined) {
    throw new ObjectStorageError('not-found', `Knowledge document not found: ${documentId}`);
  }
  return record;
}

async function writeMetadataRecord(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
  metadata: KnowledgeDocumentMetadata,
): Promise<void> {
  const keys = knowledgeDocumentKeys(resourceId, documentId);
  await store.replaceText(keys.metadataObjectKey, JSON.stringify(metadata, null, 2), 'application/json');
}

/**
 * Transition a document into `processing` for (re-)ingestion. Allowed from
 * `failed` and from a `processing` record whose claim is older than the
 * stale window (a dead run's crash recovery); a run started from `ready` —
 * or from a `processing` record another live run still owns — is rejected
 * so concurrent or accidental re-fires can never interleave index writes or
 * wipe healthy indexes. Callers treat the thrown `already-exists` as
 * "someone else owns this document right now" and must not clean up after it.
 */
export async function beginKnowledgeDocumentIngestion(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
  options: { now?: () => Date } = {},
): Promise<KnowledgeDocumentMetadata> {
  return serializeMetadataWrite(resourceId, documentId, async () => {
    const record = await readMetadataRecord(store, resourceId, documentId);
    const nowMs = (options.now?.() ?? new Date()).getTime();
    if (record.status === 'ready') {
      throw new ObjectStorageError('already-exists', 'Knowledge document is already indexed.');
    }
    if (record.status === 'processing') {
      // Freshness is judged on the claim timestamp (`ingestionStartedAt`),
      // not `updatedAt`: a fresh upload is also `processing` but no run has
      // claimed it yet, so its first ingestion must be accepted.
      const startedAtMs = parseRfc3339Timestamp(record.ingestionStartedAt ?? '');
      if (startedAtMs !== undefined && nowMs - startedAtMs < KNOWLEDGE_STALE_PROCESSING_MS) {
        throw new ObjectStorageError(
          'already-exists',
          'Knowledge document ingestion is already in progress.',
        );
      }
    }
    const updatedAt = new Date(nowMs).toISOString();
    const updated: KnowledgeDocumentMetadata = {
      ...record,
      status: 'processing',
      ingestionStartedAt: updatedAt,
      error: undefined,
      updatedAt,
    };
    await writeMetadataRecord(store, resourceId, documentId, updated);
    return updated;
  });
}

/** Mark ingestion complete: status `ready` + chunk count + embedding model. */
export async function completeKnowledgeDocumentIngestion(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
  result: { chunkCount: number; embeddingModel: string },
  options: { now?: () => Date } = {},
): Promise<KnowledgeDocumentMetadata> {
  if (!Number.isSafeInteger(result.chunkCount) || result.chunkCount < 0) {
    throw new Error('Knowledge chunk count must be a non-negative integer.');
  }
  if (typeof result.embeddingModel !== 'string' || result.embeddingModel.length === 0 || result.embeddingModel.length > MAX_EMBEDDING_MODEL_CHARS) {
    throw new Error('Knowledge embedding model must be a non-empty string of at most 200 characters.');
  }
  return serializeMetadataWrite(resourceId, documentId, async () => {
    const record = await readMetadataRecord(store, resourceId, documentId);
    const keys = knowledgeDocumentKeys(resourceId, documentId);
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    const updated: KnowledgeDocumentMetadata = {
      ...record,
      status: 'ready',
      chunkCount: result.chunkCount,
      embeddingModel: result.embeddingModel,
      extractedObjectKey: keys.extractedObjectKey,
      error: undefined,
      updatedAt,
    };
    await writeMetadataRecord(store, resourceId, documentId, updated);
    return updated;
  });
}

/**
 * Mark ingestion failed with a fixed bounded reason. Refuses to overwrite
 * `ready`: a completion that lands after a racing run's failure must win, so
 * a healthy indexed document can never be flipped to `failed` by a stale
 * loser. Callers treat the thrown `already-exists` as "the document is
 * indexed" and must not retry the failure transition.
 */
export async function failKnowledgeDocumentIngestion(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
  error: string,
  options: { now?: () => Date } = {},
): Promise<KnowledgeDocumentMetadata> {
  const boundedError = error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS - 1)}…` : error;
  return serializeMetadataWrite(resourceId, documentId, async () => {
    const record = await readMetadataRecord(store, resourceId, documentId);
    if (record.status === 'ready') {
      throw new ObjectStorageError(
        'already-exists',
        'Knowledge document is already indexed; refusing to mark it failed.',
      );
    }
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    const updated: KnowledgeDocumentMetadata = {
      ...record,
      status: 'failed',
      error: boundedError,
      updatedAt,
    };
    await writeMetadataRecord(store, resourceId, documentId, updated);
    return updated;
  });
}

/**
 * Read the original upload's bytes for the authenticated download route. The
 * key comes from the verified metadata (never from the URL), so the route can
 * never be turned into an arbitrary object reader.
 */
export async function readKnowledgeDocumentOriginalBytes(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
): Promise<KnowledgeDocumentBytes> {
  const record = await readMetadataRecord(store, resourceId, documentId);
  const binary = asBinaryObjectStorage(store);
  const result = await binary.getBytes(record.storageKey);
  return { value: result.value, contentType: record.mimeType };
}

/**
 * Delete every object belonging to one document: extraction, original, and
 * metadata LAST. Missing objects are tolerated (idempotent retries), real
 * storage failures propagate so the caller can keep the record visible and
 * let the user retry.
 */
export async function deleteKnowledgeDocumentObjects(
  store: ObjectStorage,
  resourceId: string,
  documentId: string,
): Promise<void> {
  const keys = knowledgeDocumentKeys(resourceId, documentId);
  let record: KnowledgeDocumentMetadata | undefined;
  try {
    record = await readMetadataRecord(store, resourceId, documentId);
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.code !== 'not-found') {
      throw error;
    }
  }
  const originalKey = record?.storageKey ?? keys.originalObjectKey;
  for (const key of [keys.extractedObjectKey, originalKey]) {
    try {
      await store.delete(key);
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.code !== 'not-found') {
        throw error;
      }
    }
  }
  // Metadata last: the document only leaves the UI once its payloads are gone.
  try {
    await store.delete(keys.metadataObjectKey);
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.code !== 'not-found') {
      throw error;
    }
  }
}
