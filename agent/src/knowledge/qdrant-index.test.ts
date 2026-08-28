import { describe, expect, it, vi } from 'vitest';

import {
  KnowledgeIndexError,
  createQdrantKnowledgeIndex,
  type KnowledgePoint,
} from './qdrant-index.js';

type FakeConfig = { size: number };

function createFakeClient(options: { existingDimension?: number } = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const points = new Map<string, { vector: number[]; payload: Record<string, unknown> }>();
  let dimension = options.existingDimension;
  const client = {
    async collectionExists() {
      calls.push({ method: 'collectionExists', args: {} });
      return dimension !== undefined;
    },
    async createCollection(_collection: string, params: { vectors: FakeConfig }) {
      calls.push({ method: 'createCollection', args: params as unknown as Record<string, unknown> });
      dimension = params.vectors.size;
    },
    async getCollection() {
      calls.push({ method: 'getCollection', args: {} });
      return { config: { params: { vectors: { size: dimension, distance: 'Cosine' } } } };
    },
    async createPayloadIndex(_collection: string, params: { field_name: string }) {
      calls.push({ method: 'createPayloadIndex', args: params as unknown as Record<string, unknown> });
    },
    async upsert(_collection: string, params: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }) {
      calls.push({ method: 'upsert', args: params as unknown as Record<string, unknown> });
      for (const point of params.points) {
        points.set(point.id, { vector: point.vector, payload: point.payload });
      }
    },
    async delete(_collection: string, params: { filter?: unknown }) {
      calls.push({ method: 'delete', args: params as unknown as Record<string, unknown> });
      for (const [id, point] of [...points]) {
        const payload = point.payload as { resourceId?: string; documentId?: string };
        const filter = params.filter as { must: Array<{ key: string; match: { value: string } }> };
        const matches = filter.must.every((condition) => {
          const value = payload[condition.key as 'resourceId' | 'documentId'];
          return value === condition.match.value;
        });
        if (matches) points.delete(id);
      }
    },
    async query(_collection: string, params: { query: number[]; limit: number; filter?: unknown }) {
      calls.push({ method: 'query', args: params as unknown as Record<string, unknown> });
      const filter = params.filter as { must: Array<{ key: string; match: { value: string } }> } | undefined;
      const hits = [...points.values()]
        .filter((point) => {
          if (!filter) return true;
          const payload = point.payload as Record<string, unknown>;
          return filter.must.every((condition) => payload[condition.key] === condition.match.value);
        })
        .map((point, position) => ({
          id: 'point',
          score: 0.9 - position * 0.1,
          payload: point.payload,
        }))
        .slice(0, params.limit);
      return { points: hits };
    },
  };
  return { client, calls, points };
}

function point(overrides: Partial<KnowledgePoint['payload']> = {}): KnowledgePoint {
  return {
    vector: [1, 0, 0],
    payload: {
      resourceId: 'user-a',
      documentId: 'kbd_20260828101112_abcd1234',
      filename: 'doc.pdf',
      chunkIndex: 0,
      text: 'chunk text',
      embeddingModel: 'embed',
      ...overrides,
    },
  };
}

describe('createQdrantKnowledgeIndex', () => {
  it('fails closed without configuration', async () => {
    const index = createQdrantKnowledgeIndex({ url: '', collection: 'c' });
    await expect(index.ensureCollection(4)).rejects.toMatchObject({ code: 'configuration' });
  });

  it('creates a missing collection with payload indexes', async () => {
    const fake = createFakeClient();
    const index = createQdrantKnowledgeIndex({ client: fake.client, collection: 'chekku_knowledge' });
    await index.ensureCollection(8);
    const created = fake.calls.find((call) => call.method === 'createCollection');
    expect(created?.args).toMatchObject({ vectors: { size: 8, distance: 'Cosine' } });
    const indexes = fake.calls.filter((call) => call.method === 'createPayloadIndex');
    expect(indexes.map((call) => (call.args as { field_name: string }).field_name).sort())
      .toEqual(['documentId', 'resourceId']);
  });

  it('accepts a matching collection dimension and rejects a mismatch', async () => {
    const matching = createQdrantKnowledgeIndex({
      client: createFakeClient({ existingDimension: 8 }).client,
      collection: 'c',
    });
    await expect(matching.ensureCollection(8)).resolves.toBeUndefined();

    const mismatched = createQdrantKnowledgeIndex({
      client: createFakeClient({ existingDimension: 8 }).client,
      collection: 'c',
    });
    let error: KnowledgeIndexError | undefined;
    try {
      await mismatched.ensureCollection(4);
    } catch (caught) {
      error = caught as KnowledgeIndexError;
    }
    expect(error).toBeInstanceOf(KnowledgeIndexError);
    expect(error?.code).toBe('incompatible');
    expect(error?.message).toContain('4');
  });

  it('always filters search and delete by the tenant resourceId', async () => {
    const fake = createFakeClient({ existingDimension: 3 });
    const index = createQdrantKnowledgeIndex({ client: fake.client, collection: 'c' });
    await index.upsertPoints([
      point({ resourceId: 'user-a' }),
      point({ resourceId: 'user-b', chunkIndex: 1 }),
    ]);

    const hits = await index.search([1, 0, 0], 'user-a', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].payload.resourceId).toBe('user-a');
    const queryCall = fake.calls.find((call) => call.method === 'query');
    expect(queryCall?.args.filter).toEqual({
      must: [{ key: 'resourceId', match: { value: 'user-a' } }],
    });

    await index.deleteDocumentPoints('user-a', 'kbd_20260828101112_abcd1234');
    const deleteCall = fake.calls.find((call) => call.method === 'delete');
    expect(deleteCall?.args.filter).toEqual({
      must: [
        { key: 'resourceId', match: { value: 'user-a' } },
        { key: 'documentId', match: { value: 'kbd_20260828101112_abcd1234' } },
      ],
    });
    expect(fake.points.size).toBe(1);
  });

  it('drops malformed payloads from search results', async () => {
    const fake = createFakeClient({ existingDimension: 3 });
    const index = createQdrantKnowledgeIndex({ client: fake.client, collection: 'c' });
    await index.upsertPoints([point()]);
    const good = [...fake.points.values()][0];
    fake.points.set('broken', { vector: [0, 1, 0], payload: { nope: true } as unknown as Record<string, unknown> });
    void good;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    void spy;
    const hits = await index.search([1, 0, 0], 'user-a', 5);
    expect(hits).toHaveLength(1);
  });
});
