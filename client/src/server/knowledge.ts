import 'server-only';

import {
  KNOWLEDGE_DOCUMENT_ID_RE,
  KNOWLEDGE_STALE_PROCESSING_MS,
  MAX_KNOWLEDGE_DOCUMENTS_PER_USER,
  countKnowledgeDocuments,
  createLazyGarageObjectStorage,
  failKnowledgeDocumentIngestion,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  readKnowledgeDocumentOriginalBytes,
  saveKnowledgeDocument,
  validateKnowledgeResourceId,
  type KnowledgeDocumentBytes,
  type KnowledgeDocumentMetadata,
  type KnowledgeDocumentReadResult,
  type ObjectStorage,
} from '@chekku/storage';

import { sanitizeAttachmentFilename } from '@/lib/chat-attachments';
import {
  classifyKnowledgeFile,
  knowledgeByteCap,
} from '@/lib/knowledge';

import { getUserId as getServerUserId } from './auth';

export type {
  KnowledgeDocumentBytes,
  KnowledgeDocumentMetadata,
} from '@chekku/storage';

/**
 * Server-only Knowledge Base boundary. Every function resolves the tenant
 * from the Better Auth session (never from route input), scopes all storage
 * access under `kb/users/<resourceId>/`, and maps adapter errors to the
 * bounded `{ error: { code, message } }` shape the other storage APIs use.
 *
 * Heavy ingestion/deletion runs on the agent server: this seam fires the
 * corresponding Mastra workflow fire-and-forget (same transport as the
 * social-post approval pipeline) and returns immediately — the UI polls the
 * list/metadata endpoints for the resulting state transition.
 */
export class KnowledgeServiceError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'invalid-document-id'
      | 'invalid-document'
      | 'document-limit'
      | 'not-found'
      | 'retry-not-allowed'
      | 'workflow-trigger-failed'
      | 'storage-unavailable',
    readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeServiceError';
  }
}

export interface KnowledgeServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  list?: typeof listKnowledgeDocuments;
  get?: typeof getKnowledgeDocument;
  readOriginal?: typeof readKnowledgeDocumentOriginalBytes;
  markFailed?: typeof failKnowledgeDocumentIngestion;
  startWorkflow?: (userId: string, workflowId: string, inputData: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

async function requireIdentity(resolveUserId: () => Promise<string | null>): Promise<string> {
  const userId = await resolveUserId();
  if (!userId) {
    throw new KnowledgeServiceError('forbidden', 403, 'Authentication is required.');
  }
  try {
    return validateKnowledgeResourceId(userId);
  } catch {
    throw new KnowledgeServiceError('forbidden', 403, 'Authentication is required.');
  }
}

function mapStorageError(error: unknown): never {
  if (error instanceof Error && error.name === 'ObjectStorageError') {
    const code = (error as { code?: string }).code;
    if (code === 'not-found') {
      throw new KnowledgeServiceError('not-found', 404, 'Knowledge document not found.');
    }
    throw new KnowledgeServiceError('storage-unavailable', 503, 'Knowledge storage is unavailable.');
  }
  throw error;
}

function knowledgeStore(dependencies: KnowledgeServiceDependencies): ObjectStorage {
  const rootStoreFactory = dependencies.rootStoreFactory ?? createLazyGarageObjectStorage;
  return rootStoreFactory();
}

function workflowStarter(
  dependencies: KnowledgeServiceDependencies,
): (userId: string, workflowId: string, inputData: Record<string, unknown>) => Promise<void> {
  return dependencies.startWorkflow ?? (async (userId, workflowId, inputData) => {
    const { startAgentWorkflow } = await import('./agent-workflow');
    await startAgentWorkflow(userId, workflowId, inputData);
  });
}

export async function listKnowledgeDocumentsForUser(
  dependencies: KnowledgeServiceDependencies = {},
): Promise<KnowledgeDocumentMetadata[]> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  try {
    return await (dependencies.list ?? listKnowledgeDocuments)(knowledgeStore(dependencies), userId);
  } catch (error) {
    mapStorageError(error);
  }
}

export async function getKnowledgeDocumentForUser(
  documentId: string,
  dependencies: KnowledgeServiceDependencies = {},
): Promise<KnowledgeDocumentReadResult> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(documentId)) {
    throw new KnowledgeServiceError('invalid-document-id', 400, 'Invalid knowledge document id.');
  }
  try {
    return await (dependencies.get ?? getKnowledgeDocument)(knowledgeStore(dependencies), userId, documentId);
  } catch (error) {
    mapStorageError(error);
  }
}

export async function readKnowledgeDocumentOriginalForUser(
  documentId: string,
  dependencies: KnowledgeServiceDependencies = {},
): Promise<KnowledgeDocumentBytes> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(documentId)) {
    throw new KnowledgeServiceError('invalid-document-id', 400, 'Invalid knowledge document id.');
  }
  try {
    return await (dependencies.readOriginal ?? readKnowledgeDocumentOriginalBytes)(
      knowledgeStore(dependencies),
      userId,
      documentId,
    );
  } catch (error) {
    mapStorageError(error);
  }
}

/**
 * Persist one uploaded document and kick off ingestion. The raw file and the
 * `processing` metadata record are durable before this returns; the workflow
 * trigger failing is NOT fatal to the upload — the record is marked `failed`
 * with a fixed reason so the user sees an honest retryable state instead of
 * a lost document.
 */
export async function uploadKnowledgeDocumentForUser(
  input: {
    file: { name: string; type: string; bytes: Uint8Array };
    sourceThreadId?: string;
  },
  dependencies: KnowledgeServiceDependencies = {},
): Promise<KnowledgeDocumentMetadata> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);

  // Thread ids follow the canonical `{agentId}-{resourceId}-{uuid}` shape
  // everywhere else in the repo; this annotation flows into persisted
  // metadata and model-visible tool output, so enforce the shape here too.
  const SOURCE_THREAD_ID_RE = /^[A-Za-z0-9_.:@-]{1,231}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (input.sourceThreadId !== undefined && !SOURCE_THREAD_ID_RE.test(input.sourceThreadId)) {
    throw new KnowledgeServiceError('invalid-document', 400, 'Invalid source thread reference.');
  }
  const kind = classifyKnowledgeFile({ name: input.file.name, type: input.file.type });
  if (kind === 'unsupported') {
    throw new KnowledgeServiceError(
      'invalid-document',
      400,
      'This file type cannot be added to Knowledge. Supported: text files and PDFs.',
    );
  }
  if (input.file.bytes.byteLength === 0) {
    throw new KnowledgeServiceError('invalid-document', 400, 'The uploaded file is empty.');
  }
  if (input.file.bytes.byteLength > knowledgeByteCap(kind)) {
    throw new KnowledgeServiceError('invalid-document', 413, 'This file is too large for Knowledge.');
  }
  // Filenames are attacker-controllable: apply the repo's own
  // sanitizeAttachmentFilename convention before anything persists.
  const filename = sanitizeAttachmentFilename(input.file.name);
  if (filename.length === 0) {
    throw new KnowledgeServiceError('invalid-document', 400, 'Invalid file name.');
  }
  // Uploads are auto-created by every chat send; keep one user's registry
  // bounded (storage listing + UI stay fast at the cap).
  let existingCount: number;
  try {
    existingCount = await countKnowledgeDocuments(knowledgeStore(dependencies), userId);
  } catch (error) {
    mapStorageError(error);
  }
  if (existingCount >= MAX_KNOWLEDGE_DOCUMENTS_PER_USER) {
    throw new KnowledgeServiceError(
      'document-limit',
      400,
      `Your Knowledge is full (${MAX_KNOWLEDGE_DOCUMENTS_PER_USER} documents). Delete some documents first.`,
    );
  }

  const store = knowledgeStore(dependencies);
  let metadata: KnowledgeDocumentMetadata;
  try {
    metadata = await saveKnowledgeDocument(
      store,
      {
        resourceId: userId,
        filename,
        mimeType: input.file.type || (kind === 'pdf' ? 'application/pdf' : 'text/plain'),
        kind,
        ...(input.sourceThreadId !== undefined ? { sourceThreadId: input.sourceThreadId } : {}),
        now: dependencies.now,
      },
      input.file.bytes,
    );
  } catch (error) {
    mapStorageError(error);
  }

  const documentId = metadata.id;
  try {
    await workflowStarter(dependencies)(userId, 'knowledge-document-ingestion', {
      documentId,
      resourceId: userId,
    });
  } catch (error) {
    console.error('[knowledge] ingestion trigger failed:', error);
    try {
      await (dependencies.markFailed ?? failKnowledgeDocumentIngestion)(
        store,
        userId,
        documentId,
        'Knowledge indexing could not be started. Try again from the Knowledge page.',
        { now: dependencies.now },
      );
    } catch (markError) {
      console.error('[knowledge] could not persist trigger failure:', markError);
    }
  }
  return (await (dependencies.get ?? getKnowledgeDocument)(store, userId, documentId)).metadata;
}

/**
 * Fire the deletion workflow. The record stays visible until the workflow
 * purged vectors + objects and removed the metadata LAST, so a client polling
 * the list sees the document disappear only once retrieval can no longer
 * return its chunks.
 */
export async function deleteKnowledgeDocumentForUser(
  documentId: string,
  dependencies: KnowledgeServiceDependencies = {},
): Promise<void> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(documentId)) {
    throw new KnowledgeServiceError('invalid-document-id', 400, 'Invalid knowledge document id.');
  }
  const store = knowledgeStore(dependencies);
  try {
    await (dependencies.get ?? getKnowledgeDocument)(store, userId, documentId);
  } catch (error) {
    mapStorageError(error);
  }
  try {
    await workflowStarter(dependencies)(userId, 'knowledge-document-deletion', {
      documentId,
      resourceId: userId,
    });
  } catch (error) {
    console.error('[knowledge] deletion trigger failed:', error);
    throw new KnowledgeServiceError(
      'workflow-trigger-failed',
      502,
      'Deletion could not be started. Try again.',
    );
  }
}

/**
 * Retry eligibility: `failed` documents always retry; a document stuck in
 * `processing` past {@link KNOWLEDGE_STALE_PROCESSING_MS} is treated as
 * abandoned by a dead run and may also retry.
 */
export function isKnowledgeRetryEligible(
  metadata: Pick<KnowledgeDocumentMetadata, 'status' | 'updatedAt'>,
  now: Date = new Date(),
): boolean {
  if (metadata.status === 'failed') return true;
  if (metadata.status !== 'processing') return false;
  const updatedAtMs = Date.parse(metadata.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  return now.getTime() - updatedAtMs >= KNOWLEDGE_STALE_PROCESSING_MS;
}

export async function retryKnowledgeDocumentIngestionForUser(
  documentId: string,
  dependencies: KnowledgeServiceDependencies = {},
): Promise<void> {
  const userId = await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!KNOWLEDGE_DOCUMENT_ID_RE.test(documentId)) {
    throw new KnowledgeServiceError('invalid-document-id', 400, 'Invalid knowledge document id.');
  }
  const store = knowledgeStore(dependencies);
  let metadata: KnowledgeDocumentMetadata;
  try {
    metadata = (await (dependencies.get ?? getKnowledgeDocument)(store, userId, documentId)).metadata;
  } catch (error) {
    mapStorageError(error);
  }
  if (!isKnowledgeRetryEligible(metadata, dependencies.now?.() ?? new Date())) {
    throw new KnowledgeServiceError(
      'retry-not-allowed',
      409,
      metadata.status === 'ready'
        ? 'This document is already indexed.'
        : 'This document is currently being indexed.',
    );
  }
  try {
    await workflowStarter(dependencies)(userId, 'knowledge-document-ingestion', {
      documentId,
      resourceId: userId,
    });
  } catch (error) {
    console.error('[knowledge] retry trigger failed:', error);
    throw new KnowledgeServiceError(
      'workflow-trigger-failed',
      502,
      'Retry could not be started. Try again.',
    );
  }
}
