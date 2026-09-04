import { describe, expect, it, vi } from 'vitest';

import {
  ObjectStorageError,
  saveKnowledgeDocument,
  type BinaryObjectStorage,
  type ObjectStorage,
} from '@chekku/storage';

import { runKnowledgeIngestion, type KnowledgeIngestionDeps } from './ingest.js';
import type { EmbeddingsClient } from './embeddings.js';
import type { KnowledgeVectorIndex } from './qdrant-index.js';

function createMemoryStorage(): BinaryObjectStorage {
  const objects = new Map<string, string>();
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  return {
    // Real Garage semantics: create is conditional on absence, replace on
    // existence (regression guard for the extracted.txt create-or-replace).
    async createText(key, value) {
      if (objects.has(key)) throw new ObjectStorageError('already-exists', 'Object already exists.');
      objects.set(key, value);
    },
    async replaceText(key, value) {
      if (!objects.has(key)) throw new ObjectStorageError('not-found', 'Object not found.');
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return value;
    },
    async exists(key) {
      return objects.has(key) || bytes.has(key);
    },
    async delete(key) {
      if (!objects.has(key) && !bytes.has(key)) {
        throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      }
      objects.delete(key);
      bytes.delete(key);
    },
    async listKeys(prefix) {
      return {
        keys: [...objects.keys(), ...bytes.keys()].filter((key) => key.startsWith(prefix)).sort(),
        truncated: false,
      };
    },
    async createBytes(key, value, contentType) {
      if (bytes.has(key)) throw new Error(`Already exists: ${key}`);
      bytes.set(key, { value, contentType });
    },
    async replaceBytes(key, value, contentType) {
      bytes.set(key, { value, contentType });
    },
    async getBytes(key) {
      const value = bytes.get(key);
      if (value === undefined) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return { value: value.value, contentType: value.contentType };
    },
  };
}

const USER = 'user-a';
const TEXT = 'Fakta satu tentang produk. \n\nFakta dua tentang jadwal rilis. ';

function createFakes(options: { embedError?: Error; upsertError?: Error; extract?: () => string } = {}) {
  const store = createMemoryStorage();
  const upserted: Array<{ payload: Record<string, unknown> }> = [];
  const deleted: Array<{ resourceId: string; documentId: string }> = [];
  const index: KnowledgeVectorIndex = {
    async ensureCollection() {
      // dimension detection is covered by the qdrant-index tests
    },
    async deleteDocumentPoints(resourceId, documentId) {
      deleted.push({ resourceId, documentId });
      upserted.length = 0;
    },
    async upsertPoints(points) {
      if (options.upsertError) throw options.upsertError;
      for (const point of points) {
        upserted.push({ payload: point.payload as unknown as Record<string, unknown> });
      }
    },
    async search() {
      return [];
    },
  };
  const embeddings: EmbeddingsClient = {
    model: 'test-embed-model',
    async embed(inputs) {
      if (options.embedError) throw options.embedError;
      return inputs.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };
  const deps: KnowledgeIngestionDeps = {
    storeFactory: () => store,
    indexFactory: () => index,
    embeddingsFactory: () => embeddings,
    extract: async () => ({ text: options.extract?.() ?? TEXT, truncated: false }),
  };
  return { store, deps, upserted, deleted };
}

async function upload(store: ObjectStorage): Promise<string> {
  const metadata = await saveKnowledgeDocument(
    store,
    { resourceId: USER, filename: 'handbook.pdf', mimeType: 'application/pdf', kind: 'pdf' },
    new Uint8Array([37]),
  );
  return metadata.id;
}

async function readRecord(store: ObjectStorage, documentId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await store.getText(`kb/users/${USER}/documents/${documentId}/metadata.json`));
}

describe('runKnowledgeIngestion', () => {
  it('runs the full pipeline and marks the document ready', async () => {
    const { store, deps, upserted } = createFakes();
    const documentId = await upload(store);

    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    expect(result.ok).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(upserted).toHaveLength(result.chunkCount ?? 0);
    expect(upserted[0].payload).toMatchObject({
      resourceId: USER,
      documentId,
      filename: 'handbook.pdf',
      embeddingModel: 'test-embed-model',
    });
    const record = await readRecord(store, documentId);
    expect(record.status).toBe('ready');
    expect(record.chunkCount).toBe(result.chunkCount);
    // extracted.txt persisted before metadata flipped to ready
    const extracted = await store.getText(`kb/users/${USER}/documents/${documentId}/extracted.txt`);
    expect(extracted).toContain('Fakta satu');
  });

  it('marks extraction failures as failed and preserves the raw document', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps, upserted } = createFakes({ extract: () => '   ' });
    const documentId = await upload(store);

    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No extractable text');
    const record = await readRecord(store, documentId);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('No extractable text');
    expect(upserted).toHaveLength(0);
    // Raw document preserved
    expect(await store.exists(`kb/users/${USER}/documents/${documentId}/original.pdf`)).toBe(true);
  });

  it('purges partial vectors when embedding fails midway', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps, upserted, deleted } = createFakes({
      embedError: new Error('gateway down'),
    });
    const documentId = await upload(store);

    // Seed stale vectors as a previous partial run would have left them.
    upserted.push({ payload: { resourceId: USER, documentId } });

    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('embedding model request failed');
    expect(deleted).toContainEqual({ resourceId: USER, documentId });
    expect(upserted).toHaveLength(0);
  });

  it('deletes old vectors before upserting so retries never duplicate', async () => {
    const { store, deps, upserted, deleted } = createFakes();
    const documentId = await upload(store);

    await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);
    const firstCount = upserted.length;
    expect(firstCount).toBeGreaterThan(0);

    // Simulate a retry after a crash back into `processing`.
    const record = await readRecord(store, documentId);
    record.status = 'failed';
    await store.replaceText(
      `kb/users/${USER}/documents/${documentId}/metadata.json`,
      JSON.stringify(record),
    );
    const second = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    expect(second.ok).toBe(true);
    // The pipeline cleared before re-upserting: counts stay identical, never duplicated.
    expect(upserted).toHaveLength(firstCount);
    expect(deleted.filter((entry) => entry.documentId === documentId).length).toBeGreaterThanOrEqual(2);
  });

  it('reports not-found for a foreign or missing document without indexing', async () => {
    const { deps, upserted } = createFakes();
    const result = await runKnowledgeIngestion(
      { documentId: 'kbd_20260828101112_abcd1234', resourceId: 'user-foreign' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no longer exists');
    expect(upserted).toHaveLength(0);
  });

  it('maps unconfigured embeddings/index to a fixed failure message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store } = createFakes();
    const documentId = await upload(store);
    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, {
      storeFactory: () => store,
      indexFactory: () => {
        throw new Error('Knowledge search is not configured. Set QDRANT_URL.');
      },
      embeddingsFactory: () => {
        throw new Error('Knowledge embeddings are not configured.');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
    const record = await readRecord(store, documentId);
  });

  it('leaves a ready document untouched when a racing run loses begin', async () => {
    const { store, deps, deleted, upserted } = createFakes();
    const documentId = await upload(store);
    await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);
    const readyRecord = await readRecord(store, documentId);
    const vectorsBefore = upserted.length;
    const deletionsBefore = deleted.length;

    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    // The loser of the begin race must neither purge the winner's vectors
    // nor flip the ready record to failed.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already indexed');
    expect(deleted.length).toBe(deletionsBefore);
    expect(upserted.length).toBe(vectorsBefore);
    expect(await readRecord(store, documentId)).toEqual(readyRecord);
  });

  it('reports a storage outage as unavailable instead of not-found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = createFakes();
    const documentId = await upload(store);
    store.getText = async () => {
      throw new ObjectStorageError('unavailable', 'Garage is unreachable.');
    };

    const result = await runKnowledgeIngestion({ documentId, resourceId: USER }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('storage is currently unavailable');
  });
});
