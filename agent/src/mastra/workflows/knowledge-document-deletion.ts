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
 *   3. `metadata.json` LAST — the record only leaves the UI (and the list
 *      endpoint) once both payloads are gone.
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
    console.error('[knowledge-deletion] vector purge failed:', error);
    return { ok: false, documentId: input.documentId, error: 'vector-delete-failed' };
  }

  // 2+3. Objects next, metadata last.
  try {
    await deleteKnowledgeDocumentObjects(store, input.resourceId, input.documentId);
  } catch (error) {
    console.error('[knowledge-deletion] object delete failed:', error);
    return { ok: false, documentId: input.documentId, error: 'object-delete-failed' };
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
