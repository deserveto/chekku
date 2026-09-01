import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { createEmbeddingsClient, EmbeddingsError, type EmbeddingsClient } from '../../knowledge/embeddings.js';
import {
  KnowledgeIndexError,
  createQdrantKnowledgeIndex,
  type KnowledgeVectorIndex,
} from '../../knowledge/qdrant-index.js';

/**
 * Semantic retrieval over the requesting user's Knowledge Base.
 *
 * Tenant isolation is structural: the tool derives the trusted `resourceId`
 * from the agent execution context (`context.agent.resourceId`, populated by
 * Mastra from the run's memory options — the same trusted seam the Garage
 * MCP uses for `agentId`), never from tool input. The input schema has no
 * user/document-selection fields at all, so the model cannot address another
 * tenant's knowledge even by trying. Every Qdrant search carries a mandatory
 * `resourceId` equality filter backed by a payload index.
 */

const querySchema = z.string().refine(
  (query) => query.trim().length > 0 && Buffer.byteLength(query.trim(), 'utf8') <= 1_024,
  'Query must be non-empty and at most 1,024 UTF-8 bytes.',
);

const inputSchema = z.object({
  query: querySchema,
  limit: z.number().int().min(1).max(8).optional(),
}).strict();

const resultSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  chunkIndex: z.number().int(),
  pageNumber: z.number().int().optional(),
  text: z.string(),
  score: z.number(),
  sourceThreadId: z.string().optional(),
}).strict();

const outputSchema = z.object({
  query: z.string(),
  results: z.array(resultSchema),
  truncated: z.boolean(),
}).strict();

export type SearchKnowledgeBaseDeps = {
  embeddingsFactory?: () => EmbeddingsClient;
  indexFactory?: () => KnowledgeVectorIndex;
};

const DEFAULT_LIMIT = 5;
/** One extra hit detects truncation without over-fetching. */
const OVERFETCH = 1;

export function createSearchKnowledgeBaseTool(deps: SearchKnowledgeBaseDeps = {}) {
  let embeddings: EmbeddingsClient | undefined;
  let index: KnowledgeVectorIndex | undefined;
  const getEmbeddings = (): EmbeddingsClient => {
    embeddings ??= deps.embeddingsFactory?.() ?? createEmbeddingsClient();
    return embeddings;
  };
  const getIndex = (): KnowledgeVectorIndex => {
    index ??= deps.indexFactory?.() ?? createQdrantKnowledgeIndex();
    return index;
  };

  const tool = createTool({
    id: 'search_knowledge_base',
    description:
      'Search the current user\'s Knowledge Base — documents they previously uploaded in Chekku '
      + '(text files and PDFs, parsed and indexed). Use it when a question seems to depend on '
      + 'documents the user uploaded earlier and that content is not already present in the current '
      + 'conversation. Returns the most relevant text chunks with their source document metadata.',
    inputSchema,
    outputSchema,
    mcp: { annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    } },
    execute: async (input, context) => {
      // Trusted tenant identity — captured from the server-owned run context.
      const resourceId = context?.agent?.resourceId;
      if (!resourceId) {
        throw new Error('Knowledge search requires an authenticated run context.');
      }
      // Lazy init failures are configuration errors; let their fixed messages
      // propagate instead of masking them as transient.
      const embeddingsClient = getEmbeddings();
      const indexInstance = getIndex();

      const query = input.query.trim();
      let queryVector: number[];
      try {
        queryVector = (await embeddingsClient.embed([query]))[0];
      } catch (error) {
        if (error instanceof EmbeddingsError && error.code === 'configuration') throw error;
        throw new Error('Knowledge search is temporarily unavailable. Try again shortly.');
      }
      let hits;
      try {
        hits = await indexInstance.search(queryVector, resourceId, (input.limit ?? DEFAULT_LIMIT) + OVERFETCH);
      } catch (error) {
        if (error instanceof KnowledgeIndexError && error.code === 'configuration') throw error;
        if (error instanceof KnowledgeIndexError && error.code === 'incompatible') throw error;
        throw new Error('Knowledge search is temporarily unavailable. Try again shortly.');
      }
      const truncated = hits.length > (input.limit ?? DEFAULT_LIMIT);
      return {
        query,
        results: hits.slice(0, input.limit ?? DEFAULT_LIMIT).map((hit) => ({
          documentId: hit.payload.documentId,
          filename: hit.payload.filename,
          chunkIndex: hit.payload.chunkIndex,
          ...(hit.payload.pageNumber !== undefined ? { pageNumber: hit.payload.pageNumber } : {}),
          text: hit.payload.text,
          score: Number(hit.score.toFixed(4)),
          ...(hit.payload.sourceThreadId !== undefined ? { sourceThreadId: hit.payload.sourceThreadId } : {}),
        })),
        truncated,
      };
    },
  });
  tool.requireApproval = undefined;
  return tool as typeof tool & {
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
  };
}

export const searchKnowledgeBaseTool = createSearchKnowledgeBaseTool();
