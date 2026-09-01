import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  KNOWLEDGE_DOCUMENT_ID_RE,
  KNOWLEDGE_RESOURCE_ID_RE,
} from '@chekku/storage';
import { z } from 'zod';

import { runKnowledgeIngestion } from '../../knowledge/ingest.js';

/**
 * Knowledge Base ingestion workflow.
 *
 * Fired fire-and-forget by the Next.js upload route
 * (`POST /api/storage/knowledge/documents`) AFTER the raw document and its
 * `processing` metadata record are durably persisted in Garage. The workflow
 * re-verifies ownership by loading the record through the scoped storage
 * helpers (a foreign `resourceId`/`documentId` pair collapses to not-found),
 * then runs extract → chunk → embed → index and flips the record to `ready`
 * or `failed`.
 *
 * Observers watch the document metadata (like the social-post workflows)
 * rather than the run: the Knowledge page polls the list endpoint while a
 * document is `processing`.
 */

export const knowledgeDocumentIngestionInputSchema = z.object({
  documentId: z.string().regex(KNOWLEDGE_DOCUMENT_ID_RE, 'Invalid knowledge document id.'),
  resourceId: z.string().regex(KNOWLEDGE_RESOURCE_ID_RE, 'Invalid resource id.'),
});

export const knowledgeDocumentIngestionOutputSchema = z.object({
  ok: z.boolean(),
  documentId: z.string(),
  resourceId: z.string(),
  chunkCount: z.number().int().optional(),
  error: z.string().optional(),
});

export type KnowledgeDocumentIngestionResult = z.infer<typeof knowledgeDocumentIngestionOutputSchema>;
const runIngestionStep = createStep({
  id: 'run-knowledge-document-ingestion',
  inputSchema: knowledgeDocumentIngestionInputSchema,
  outputSchema: knowledgeDocumentIngestionOutputSchema,
  execute: async ({ inputData }) => runKnowledgeIngestion(inputData),
});

/**
 * Manual-trigger workflow (no schedule). Started fire-and-forget by the
 * client upload seam and by the retry route for failed/stale documents.
 */
export const knowledgeDocumentIngestion = createWorkflow({
  id: 'knowledge-document-ingestion',
  inputSchema: knowledgeDocumentIngestionInputSchema,
  outputSchema: knowledgeDocumentIngestionOutputSchema,
})
  .then(runIngestionStep)
  .commit();
