import { randomUUID } from 'node:crypto';

import { QdrantClient, type QdrantClientParams } from '@qdrant/js-client-rest';

import { env } from '../config/env.js';

/**
 * Vector-index boundary for the Knowledge Base.
 *
 * One shared Qdrant collection holds every user's chunks; tenant isolation is
 * enforced by a mandatory `resourceId` equality filter on EVERY search and
 * delete (and by the payload `resourceId` keyword index, so the filter is
 * backed by an index, not a scan). The LLM never supplies a resourceId — the
 * callers pass the trusted identity captured from the run context.
 *
 * The narrow {@link KnowledgeVectorIndex} interface is the seam that keeps
 * the ingestion pipeline and the retrieval tool testable without Qdrant.
 */

export type KnowledgeIndexErrorCode = 'configuration' | 'incompatible' | 'unavailable' | 'format';

export class KnowledgeIndexError extends Error {
  constructor(public readonly code: KnowledgeIndexErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgeIndexError';
  }
}

/** Payload stored beside every chunk vector. Bounded, structured, no binaries. */
export interface KnowledgePointPayload {
  resourceId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  pageNumber?: number;
  mimeType?: string;
  sourceThreadId?: string;
  embeddingModel: string;
}

export interface KnowledgePoint {
  vector: number[];
  payload: KnowledgePointPayload;
}

export interface KnowledgeSearchHit {
  score: number;
  payload: KnowledgePointPayload;
}

export interface KnowledgeVectorIndex {
  /** Create the collection when missing; validate dimension when present. */
  ensureCollection(dimension: number): Promise<void>;
  /** Delete every vector belonging to one document (mandatory tenant filter). */
  deleteDocumentPoints(resourceId: string, documentId: string): Promise<void>;
  /** Upsert a bounded batch of chunk points. */
  upsertPoints(points: KnowledgePoint[]): Promise<void>;
  /** Search one tenant's chunks; the resourceId filter is non-negotiable. */
  search(queryVector: number[], resourceId: string, limit: number): Promise<KnowledgeSearchHit[]>;
}

export interface QdrantKnowledgeIndexOptions {
  url?: string;
  apiKey?: string;
  collection?: string;
  /** Pre-built client — dependency seam for tests. */
  client?: QdrantClientLike;
}

/**
 * The narrow slice of the Qdrant REST client Chekku actually uses. Defining
 * it structurally keeps the seam testable without dragging QdrantClient's
 * full parameter unions into tests.
 *
 * `collectionExists` resolves to `{ exists: boolean }` — the runtime shape
 * of `@qdrant/js-client-rest`'s method. Typing it as a bare `boolean` once
 * made every missing-collection guard skip its branch (a truthy object is
 * never falsy), so ingestion 404'd against an absent collection instead of
 * creating it; keep the object shape authoritative.
 */
export interface QdrantClientLike {
  collectionExists(collection: string): Promise<{ exists: boolean }>;
  createCollection(collection: string, params: { vectors: { size: number; distance: 'Cosine' } }): Promise<unknown>;
  getCollection(collection: string): Promise<unknown>;
  createPayloadIndex(collection: string, params: {
    field_name: string;
    field_schema: string;
    wait?: boolean;
  }): Promise<unknown>;
  upsert(collection: string, params: {
    wait?: boolean;
    points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>;
  }): Promise<unknown>;
  delete(collection: string, params: { wait?: boolean; filter?: Record<string, unknown> }): Promise<unknown>;
  query(collection: string, params: {
    query: number[];
    limit: number;
    filter?: Record<string, unknown>;
    with_payload?: boolean;
  }): Promise<{ points: Array<{ score?: number; payload?: unknown }> }>;
}

interface ResolvedQdrantOptions extends ResolvedQdrantConfigFields {
  client: QdrantKnowledgeIndexOptions['client'];
}

interface ResolvedQdrantConfigFields {
  url: string;
  apiKey: string;
  collection: string;
}

function resolveOptions(explicit?: QdrantKnowledgeIndexOptions): ResolvedQdrantOptions {
  return {
    url: (explicit?.url ?? env.QDRANT_URL).replace(/\/+$/, ''),
    apiKey: explicit?.apiKey ?? env.QDRANT_API_KEY,
    collection: explicit?.collection ?? env.QDRANT_COLLECTION,
    client: explicit?.client,
  };
}

function requireConfigured(options: ResolvedQdrantOptions): asserts options is ResolvedQdrantOptions & ResolvedQdrantConfigFields {
  if (!options.url) {
    throw new KnowledgeIndexError(
      'configuration',
      'Knowledge search is not configured. Set QDRANT_URL.',
    );
  }
}

/** Bound every Qdrant call; the library default is 300 s, which could freeze
 * tool calls and workflows for minutes on a stalled server. */
const QDRANT_TIMEOUT_MS = 30_000;

const UPSERT_BATCH_SIZE = 64;

function tenantFilter(resourceId: string, documentId?: string) {
  return {
    must: [
      { key: 'resourceId', match: { value: resourceId } },
      ...(documentId !== undefined ? [{ key: 'documentId', match: { value: documentId } }] : []),
    ],
  };
}

function parsePayload(raw: unknown, resourceId: string): KnowledgePointPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const payload = raw as Record<string, unknown>;
  if (payload.resourceId !== resourceId) return undefined;
  if (typeof payload.documentId !== 'string') return undefined;
  if (typeof payload.filename !== 'string') return undefined;
  if (typeof payload.text !== 'string') return undefined;
  if (typeof payload.chunkIndex !== 'number' || !Number.isSafeInteger(payload.chunkIndex)) return undefined;
  if (typeof payload.embeddingModel !== 'string') return undefined;
  const pageNumber = payload.pageNumber;
  if (pageNumber !== undefined && (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber))) return undefined;
  const mimeType = payload.mimeType;
  if (mimeType !== undefined && typeof mimeType !== 'string') return undefined;
  const sourceThreadId = payload.sourceThreadId;
  if (sourceThreadId !== undefined && typeof sourceThreadId !== 'string') return undefined;
  return {
    resourceId,
    documentId: payload.documentId,
    filename: payload.filename,
    chunkIndex: payload.chunkIndex,
    text: payload.text,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    embeddingModel: payload.embeddingModel,
  };
}

/**
 * Read the vector size from a Qdrant collection description. The single
 * (unnamed) vector config lives at `config.params.vectors`; tolerate a plain
 * number/object at `config.params` for forward compatibility.
 */
function collectionVectorSize(collectionInfo: unknown): number | undefined {
  if (typeof collectionInfo !== 'object' || collectionInfo === null) return undefined;
  const config = (collectionInfo as { config?: { params?: unknown } }).config;
  const vectors = (config?.params as { vectors?: unknown } | undefined)?.vectors ?? config?.params;
  if (typeof vectors === 'number') return vectors;
  if (typeof vectors === 'object' && vectors !== null && 'size' in vectors) {
    const size = (vectors as { size?: unknown }).size;
    if (typeof size === 'number') return size;
  }
}

/** Fixed-code operation logging: safe operation name + error code/name only —
 * never API keys, URLs, provider bodies, or raw payloads. */
function logQdrantOperationFailure(operation: string, error: unknown): void {
  const code = error instanceof KnowledgeIndexError ? error.code
    : error instanceof Error ? error.name
    : 'unknown';
  console.error(`[knowledge] qdrant ${operation} failed:`, code);
}

function mapIndexError(error: unknown): KnowledgeIndexError {
  if (error instanceof KnowledgeIndexError) return error;
  // Fixed-code logging: raw provider errors can embed URLs and bodies, so
  // only the error name reaches the log line.
  console.error('[knowledge] qdrant request failed:', error instanceof Error ? error.name : 'unknown');
  return new KnowledgeIndexError('unavailable', 'The knowledge index is currently unavailable.');
}

/** Read the indexed payload fields from a collection description. Qdrant has
 * shipped `payload_schema` as both a keyed object and a list across versions;
 * accept either shape. */
function indexedPayloadFields(collectionInfo: unknown): Set<string> {
  const fields = new Set<string>();
  if (typeof collectionInfo !== 'object' || collectionInfo === null) return fields;
  const schema = (collectionInfo as { payload_schema?: unknown }).payload_schema;
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      if (typeof entry === 'object' && entry !== null && 'field_name' in entry) {
        const name = (entry as { field_name?: unknown }).field_name;
        if (typeof name === 'string') fields.add(name);
      }
    }
  } else if (typeof schema === 'object' && schema !== null) {
    for (const name of Object.keys(schema)) fields.add(name);
  }
  return fields;
}

/**
 * Create one payload index, tolerating a concurrent creator: after any
 * failure, only rethrow when the field is still missing from the collection's
 * payload schema. Makes index (re)creation idempotent.
 */
async function ensurePayloadIndex(
  client: QdrantClientLike,
  collection: string,
  fieldName: string,
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
      field_name: fieldName,
      field_schema: 'keyword',
      wait: true,
    });
  } catch (error) {
    const info = await client.getCollection(collection);
    if (!indexedPayloadFields(info).has(fieldName)) throw error;
  }
}

/**
 * Qdrant-backed Knowledge Index. Configuration resolves from the environment
 * unless overridden; pass `client` in tests to inject a double.
 */
export function createQdrantKnowledgeIndex(explicit?: QdrantKnowledgeIndexOptions): KnowledgeVectorIndex {
  const options = resolveOptions(explicit);
  const clientHolder: { client?: QdrantClientLike } = { client: explicit?.client };

  const getClient = (): QdrantClientLike => {
    if (clientHolder.client !== undefined) {
      return clientHolder.client;
    }
    requireConfigured(options);
    clientHolder.client = new QdrantClient({
      url: options.url,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      checkCompatibility: false,
      timeout: QDRANT_TIMEOUT_MS,
    } satisfies QdrantClientParams) as unknown as QdrantClientLike;
    return clientHolder.client;
  };

  return {
    async ensureCollection(dimension: number): Promise<void> {
      try {
        const client = getClient();
        if (!(await client.collectionExists(options.collection)).exists) {
          try {
            await client.createCollection(options.collection, {
              vectors: { size: dimension, distance: 'Cosine' },
            });
          } catch (error) {
            // Lost a concurrent first-upload race: the winner's collection
            // is exactly as good as ours would have been. Only a still-missing
            // collection is a real failure.
            if (!(await client.collectionExists(options.collection)).exists) throw error;
          }
        }
        const info = await client.getCollection(options.collection);
        const existing = collectionVectorSize(info);
        if (existing !== undefined && existing !== dimension) {
          throw new KnowledgeIndexError(
            'incompatible',
            `Knowledge index "${options.collection}" was created for ${existing}-dimension vectors but the configured embedding model produces ${dimension}. Restore the previous LLM_EMBEDDING_MODEL or delete the collection to reindex.`,
          );
        }
        // Tenant + document filters are the hot path; ensure BOTH payload
        // indexes on every pass so a half-created collection (crash between
        // createCollection and createPayloadIndex) self-repairs instead of
        // staying unindexed forever.
        await ensurePayloadIndex(client, options.collection, 'resourceId');
        await ensurePayloadIndex(client, options.collection, 'documentId');
      } catch (error) {
        logQdrantOperationFailure('ensureCollection', error);
        throw mapIndexError(error);
      }
    },

    // A missing collection means "nothing indexed yet": deletion is a no-op
    // (existence pre-checked because the REST client surfaces 404s only
    // through error text, not structured status).
    async deleteDocumentPoints(resourceId: string, documentId: string): Promise<void> {
      try {
        const client = getClient();
        if (!(await client.collectionExists(options.collection)).exists) return;
        await client.delete(options.collection, {
          filter: tenantFilter(resourceId, documentId),
          wait: true,
        });
      } catch (error) {
        logQdrantOperationFailure('deleteDocumentPoints', error);
        throw mapIndexError(error);
      }
    },

    async upsertPoints(points: KnowledgePoint[]): Promise<void> {
      if (points.length === 0) return;
      try {
        const client = getClient();
        for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
          const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
          await client.upsert(options.collection, {
            wait: true,
            points: batch.map((point) => ({
              id: randomUUID(),
              vector: point.vector,
              payload: point.payload as unknown as Record<string, unknown>,
            })),
          });
        }
      } catch (error) {
        logQdrantOperationFailure('upsertPoints', error);
        throw mapIndexError(error);
      }
    },
    // A missing collection means "nothing indexed yet": zero hits instead of
    // an availability error (existence pre-checked like deletion), so the
    // tool reports an empty Knowledge Base rather than failing on a server
    // where no ingestion has ever succeeded.
    async search(queryVector: number[], resourceId: string, limit: number): Promise<KnowledgeSearchHit[]> {
      try {
        const client = getClient();
        if (!(await client.collectionExists(options.collection)).exists) return [];
        const response = await client.query(options.collection, {
          query: queryVector,
          limit,
          filter: tenantFilter(resourceId),
          with_payload: true,
        });
        const hits: KnowledgeSearchHit[] = [];
        for (const point of response.points) {
          const payload = parsePayload(point.payload, resourceId);
          if (payload === undefined) continue;
          hits.push({ score: typeof point.score === 'number' ? point.score : 0, payload });
        }
        return hits;
      } catch (error) {
        logQdrantOperationFailure('search', error);
        throw mapIndexError(error);
      }
    },
  };
}
