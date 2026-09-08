import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createSearchKnowledgeBaseTool } from './knowledge-search.js';
import type { EmbeddingsClient } from '../../knowledge/embeddings.js';
import type { KnowledgeVectorIndex } from '../../knowledge/qdrant-index.js';

function createFakeIndex(hits: Array<{ score: number; payload: Record<string, unknown> }> = []) {
  const searches: Array<{ vector: number[]; resourceId: string; limit: number }> = [];
  const index: KnowledgeVectorIndex = {
    async ensureCollection() {},
    async deleteDocumentPoints() {},
    async upsertPoints() {},
    async search(vector, resourceId, limit) {
      searches.push({ vector, resourceId, limit });
      return hits as never;
    },
  };
  return { index, searches };
}

function createFakeEmbeddings(dimension = 3) {
  const embedded: string[] = [];
  const embeddings: EmbeddingsClient = {
    model: 'embed-x',
    async embed(inputs) {
      embedded.push(...inputs);
      return inputs.map(() => Array.from({ length: dimension }, () => 0.2));
    },
  };
  return { embeddings, embedded };
}

const hit = (resourceId: string, text = 'chunk') => ({
  score: 0.87,
  payload: {
    resourceId,
    documentId: 'kbd_20260828101112_abcd1234',
    filename: 'handbook.pdf',
    chunkIndex: 2,
    text,
    pageNumber: 3,
    embeddingModel: 'embed-x',
  },
});
type Output = { query: string; results: Array<Record<string, unknown>>; truncated: boolean };

describe('search_knowledge_base tool', () => {
  it('searches with the trusted context resourceId and returns bounded chunks', async () => {
    const { index, searches } = createFakeIndex([hit('user-a')]);
    const { embeddings, embedded } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });

    const output = await tool.execute?.(
      { query: 'vacation policy', limit: 3 },
      { agent: { resourceId: 'user-a' } } as never,
    ) as Output;

    expect(searches[0]).toMatchObject({ resourceId: 'user-a', limit: 4 });
    expect(output?.query).toBe('vacation policy');
    expect(output?.results).toHaveLength(1);
    expect(output?.results[0]).toMatchObject({
      documentId: 'kbd_20260828101112_abcd1234',
      filename: 'handbook.pdf',
      chunkIndex: 2,
      pageNumber: 3,
      score: 0.87,
    });
    expect(output?.truncated).toBe(false);
  });

  it('defaults the limit to 5 and flags truncation via overfetch', async () => {
    const { index, searches } = createFakeIndex([hit('user-a'), hit('user-a')]);
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });

    const output = await tool.execute?.({ query: 'x' }, { agent: { resourceId: 'user-a' } } as never) as Output;

    expect(searches[0].limit).toBe(6);
    expect(output?.results).toHaveLength(2);
    expect(output?.truncated).toBe(false);
  });

  it('refuses to run without a trusted resourceId in context', async () => {
    const { index } = createFakeIndex();
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });

    await expect(
      tool.execute?.({ query: 'x' }, {} as never),
    ).rejects.toThrow(/authenticated run context/);
  });

  it('rejects model-supplied tenant fields through strict input validation', async () => {
    const { index } = createFakeIndex();
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });

    // `resourceId` is not part of the input schema at all — strict validation
    // rejects the call (Mastra returns a validation error result for schema
    // violations rather than rejecting the promise).
    const validation = await tool.execute?.(
      { query: 'x', resourceId: 'user-b' } as never,
      { agent: { resourceId: 'user-a' } } as never,
    ) as { error?: unknown } | undefined;
    expect(validation?.error).toBeTruthy();
  });

  it('prefers the server-owned requestContext identity over context.agent', async () => {
    const { index, searches } = createFakeIndex([hit('user-a')]);
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });
    const requestContext = new RequestContext([
      [MASTRA_RESOURCE_ID_KEY, 'owner-user'],
    ]);

    await tool.execute?.(
      { query: 'x' },
      {
        requestContext,
        // A disagreeing framework-assembled value must lose.
        agent: { resourceId: 'attacker-user' },
      } as never,
    );

    expect(searches[0]?.resourceId).toBe('owner-user');
  });

  it('falls back to context.agent.resourceId when no requestContext is present', async () => {
    const { index, searches } = createFakeIndex([hit('user-a')]);
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => index });

    await tool.execute?.({ query: 'x' }, { agent: { resourceId: 'user-a' } } as never);

    expect(searches[0]?.resourceId).toBe('user-a');
  });

  it('fails closed with the fixed configuration error when unconfigured', async () => {
    const tool = createSearchKnowledgeBaseTool({
      embeddingsFactory: () => {
        throw new Error('Knowledge embeddings are not configured. Set LLM_BASE_URL and LLM_EMBEDDING_MODEL.');
      },
      indexFactory: () => {
        throw new Error('Knowledge search is not configured. Set QDRANT_URL.');
      },
    });
    await expect(
      tool.execute?.({ query: 'x' }, { agent: { resourceId: 'user-a' } } as never),
    ).rejects.toThrow(/not configured/);
  });

  it('maps transient index failures to a bounded availability error', async () => {
    const failingIndex: KnowledgeVectorIndex = {
      async ensureCollection() {},
      async deleteDocumentPoints() {},
      async upsertPoints() {},
      async search() {
        throw new Error('connection refused 10.0.0.1:6334 secret=abc');
      },
    };
    const { embeddings } = createFakeEmbeddings();
    const tool = createSearchKnowledgeBaseTool({ embeddingsFactory: () => embeddings, indexFactory: () => failingIndex });
    await expect(
      tool.execute?.({ query: 'x' }, { agent: { resourceId: 'user-a' } } as never),
    ).rejects.toThrow(/temporarily unavailable/);
  });
});
