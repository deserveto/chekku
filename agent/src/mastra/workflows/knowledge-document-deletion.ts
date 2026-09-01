import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  KNOWLEDGE_DOCUMENT_ID_RE,
  KNOWLEDGE_RESOURCE_ID_RE,
  createLazyGarageObjectStorage,
  deleteKnowledgeDocumentObjects,
  getKnowledgeDocument,
  type ObjectStorage,
} from '@chekku/storage';
import { z } from 'zod';

import { createQdrantKnowledgeIndex, type KnowledgeVectorIndex } from '../../knowledge/qdrant-index.js';

/**
 * Knowledge Base deletion workflow.
 *
 * Fired fire-and-forget by `DELETE /api/storage/knowledge/documents/:id`.
 * Order matters and mirrors the social-post "metadata writes last" rule, in
 * reverse for deletion:
 *
 *   1. Qdrant points for the document (tenant-filtered) — retrieval stops
 *      FIRST, so a deleted document can never surface in KB search, not even
 *      briefly.
 *   2. Garage original + extracted objects.
 *   3. `metadata.json` — the record only leaves the UI (and the list
 *      endpoint) once both payloads are gone.
 *   4. Final idempotent vector sweep — an ingestion racing this deletion
 *      can re-create points after step 1 (its success path runs
 *      delete-before-upsert then completes before our metadata delete
 *      lands). With the registry record gone nothing else can ever purge
 *      those points, so this last pass keeps search results honest.
 *
 * Every step is idempotent and tolerates missing objects, so a failed run
 * can simply be retried from the Knowledge page; the document stays visible
 * with its previous status until the whole deletion completes.
 */

export const knowledgeDocumentDeletionInputSchema = z.object({
  documentId: z.string().regex(KNOWLEDGE_DOCUMENT_ID_RE, 'Invalid knowledge document id.'),
  resourceId: z.string().regex(KNOWLEDGE_RESOURCE_ID_RE, 'Invalid resource id.'),
});

export const knowledgeDocumentDeletionOutputSchema = z.object({
  ok: z.boolean(),
  documentId: z.string(),
  error: z.string().optional(),
});

export type KnowledgeDocumentDeletionResult = z.infer<typeof knowledgeDocumentDeletionOutputSchema>;

export interface KnowledgeDocumentDeletionDeps {
  storeFactory?: () => ObjectStorage;
  indexFactory?: () => KnowledgeVectorIndex;
  now?: () => Date;
}

export async function runKnowledgeDocumentDeletion(
  input: z.infer<typeof knowledgeDocumentDeletionInputSchema>,
  deps: KnowledgeDocumentDeletionDeps = {},
): Promise<KnowledgeDocumentDeletionResult> {
  const store = (deps.storeFactory ?? createLazyGarageObjectStorage)();
  const index = deps.indexFactory?.() ?? createQdrantKnowledgeIndex();

  const logCode = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

  // Ownership gate: a foreign pair collapses to not-found before any delete.
  try {
    await getKnowledgeDocument(store, input.resourceId, input.documentId);
  } catch {
    return { ok: false, documentId: input.documentId, error: 'not-found' };
  }

  // 1. Vectors first — retrieval stops immediately.
  try {
    await index.deleteDocumentPoints(input.resourceId, input.documentId);
  } catch (error) {
    console.error('[knowledge-deletion] vector purge failed:', logCode(error));
    return { ok: false, documentId: input.documentId, error: 'vector-delete-failed' };
  }

  // 2+3. Objects next, metadata last.
  try {
    await deleteKnowledgeDocumentObjects(store, input.resourceId, input.documentId);
  } catch (error) {
    console.error('[knowledge-deletion] object delete failed:', logCode(error));
    return { ok: false, documentId: input.documentId, error: 'object-delete-failed' };
  }

  // 4. Final idempotent vector sweep (see doc comment): best-effort, retried
  // a few times so a transient blip cannot orphan searchable chunks forever.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await index.deleteDocumentPoints(input.resourceId, input.documentId);
      break;
    } catch (error) {
      if (attempt === 2) console.error('[knowledge-deletion] final vector sweep failed:', logCode(error));
    }
  }

  return { ok: true, documentId: input.documentId };
}

const runDeletionStep = createStep({
  id: 'run-knowledge-document-deletion',
  inputSchema: knowledgeDocumentDeletionInputSchema,
  outputSchema: knowledgeDocumentDeletionOutputSchema,
  execute: async ({ inputData }) => runKnowledgeDocumentDeletion(inputData),
});

/**
 * Manual-trigger workflow (no schedule). Started fire-and-forget by the
 * client delete seam; the Knowledge page polls the list/metadata endpoint
 * until the record disappears (or surfaces an error state for retry).
 */
export const knowledgeDocumentDeletion = createWorkflow({
  id: 'knowledge-document-deletion',
  inputSchema: knowledgeDocumentDeletionInputSchema,
  outputSchema: knowledgeDocumentDeletionOutputSchema,
})
  .then(runDeletionStep)
  .commit();
