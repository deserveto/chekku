import { describe, expect, it } from 'vitest';

import { ObjectStorageError } from './objects.ts';
import type { BinaryObjectStorage, ObjectStorage } from './objects.ts';
import {
  KNOWLEDGE_DOCUMENT_ID_RE,
  KNOWLEDGE_RESOURCE_ID_RE,
  KNOWLEDGE_STALE_PROCESSING_MS,
  beginKnowledgeDocumentIngestion,
  buildKnowledgeDocument,
  completeKnowledgeDocumentIngestion,
  countKnowledgeDocuments,
  createKnowledgeDocumentId,
  deleteKnowledgeDocumentObjects,
  extensionForKnowledgeDocument,
  failKnowledgeDocumentIngestion,
  getKnowledgeDocument,
  knowledgeDocumentKeys,
  listKnowledgeDocuments,
  parseKnowledgeDocumentTimestamp,
  readKnowledgeDocumentOriginalBytes,
  saveKnowledgeDocument,
  validateKnowledgeResourceId,
} from './knowledge-documents.ts';

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  const writeOrder: string[] = [];
  const deleted: string[] = [];
  const storage: BinaryObjectStorage & { writeOrder: string[]; deleted: string[] } = {
    writeOrder,
    deleted,
    async createText(key, value, contentType) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      writeOrder.push(key);
      objects.set(key, value);
    },
    async replaceText(key, value, contentType) {
      writeOrder.push(key);
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
      deleted.push(key);
      objects.delete(key);
      bytes.delete(key);
    },
    async listKeys(prefix) {
      const keys = [...objects.keys(), ...bytes.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      return { keys, truncated: false };
    },
    async createBytes(key, value, contentType) {
      if (bytes.has(key)) throw new Error(`Already exists: ${key}`);
      writeOrder.push(key);
      bytes.set(key, { value, contentType });
    },
    async replaceBytes(key, value, contentType) {
      writeOrder.push(key);
      bytes.set(key, { value, contentType });
    },
    async getBytes(key) {
      const value = bytes.get(key);
      if (value === undefined) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return { value: value.value, contentType: value.contentType };
    },
  };
  return storage;
}

const USER_A = 'user-a-identifier';
const USER_B = 'user-b-identifier';

function uploadInput(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: USER_A,
    filename: 'handbook.pdf',
    mimeType: 'application/pdf',
    kind: 'pdf' as const,
    ...(overrides as { sourceThreadId?: string; now?: () => Date }),
  };
}

describe('knowledge document ids and keys', () => {
  it('creates canonical ids and parses their timestamps', () => {
    const now = new Date('2026-08-28T10:11:12Z');
    const id = createKnowledgeDocumentId(now);
    expect(id).toMatch(KNOWLEDGE_DOCUMENT_ID_RE);
    expect(parseKnowledgeDocumentTimestamp(id)).toBe(Date.parse('2026-08-28T10:11:12Z'));
    expect(parseKnowledgeDocumentTimestamp('smp_20260828101112_abcd1234')).toBeUndefined();
  });

  it('builds scoped keys and rejects path-injecting resource ids', () => {
    const keys = knowledgeDocumentKeys(USER_A, 'kbd_20260828101112_abcd1234');
    expect(keys.basePrefix).toBe(`kb/users/${USER_A}/documents/kbd_20260828101112_abcd1234`);
    expect(keys.metadataObjectKey).toBe(`${keys.basePrefix}/metadata.json`);

    for (const hostile of ['../etc', 'a/b', '', 'a'.repeat(129), 'spa ce']) {
      expect(() => validateKnowledgeResourceId(hostile)).toThrow(ObjectStorageError);
    }
    expect(validateKnowledgeResourceId('user_123.test@ok')).toBe('user_123.test@ok');
    expect(KNOWLEDGE_RESOURCE_ID_RE.test('a'.repeat(128))).toBe(true);
  });

  it('resolves safe extensions only', () => {
    expect(extensionForKnowledgeDocument('pdf', 'doc.PDF')).toBe('pdf');
    expect(extensionForKnowledgeDocument('text', 'notes.md')).toBe('md');
    expect(extensionForKnowledgeDocument('text', 'archive.exe')).toBe('txt');
    expect(extensionForKnowledgeDocument('text', 'data.json')).toBe('json');
  });
});

describe('knowledge document persistence', () => {
  it('saves bytes first and metadata last, then reads back', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(
      store,
      uploadInput({ sourceThreadId: 'main-agent-u1-uuid' }),
      new Uint8Array([1, 2, 3]),
    );
    expect(metadata.status).toBe('processing');
    expect(metadata.sizeBytes).toBe(3);
    expect(metadata.storageKey).toBe(`kb/users/${USER_A}/documents/${metadata.id}/original.pdf`);
    // Original bytes must be written before the metadata record.
    expect(store.writeOrder[0]).toBe(metadata.storageKey);
    expect(store.writeOrder[1]).toBe(`kb/users/${USER_A}/documents/${metadata.id}/metadata.json`);

    const read = await getKnowledgeDocument(store, USER_A, metadata.id);
    expect(read.metadata.id).toBe(metadata.id);
    const bytes = await readKnowledgeDocumentOriginalBytes(store, USER_A, metadata.id);
    expect([...bytes.value]).toEqual([1, 2, 3]);
    expect(bytes.contentType).toBe('application/pdf');
  });

  it('rejects empty bytes and blank filenames', async () => {
    const store = createMemoryStorage();
    await expect(
      saveKnowledgeDocument(store, uploadInput(), new Uint8Array()),
    ).rejects.toThrow(/bytes must be non-empty/i);
    await expect(
      saveKnowledgeDocument(store, uploadInput({ filename: '' }), new Uint8Array([1])),
    ).rejects.toThrow(/filename/i);
  });

  it('lists newest first and enforces tenant isolation', async () => {
    const store = createMemoryStorage();
    await saveKnowledgeDocument(store, uploadInput({ now: () => new Date('2026-08-28T00:00:00Z') }), new Uint8Array([1]));
    await saveKnowledgeDocument(store, uploadInput({ now: () => new Date('2026-08-29T00:00:00Z') }), new Uint8Array([2]));
    await saveKnowledgeDocument(store, { ...uploadInput(), resourceId: USER_B }, new Uint8Array([3]));

    const docsA = await listKnowledgeDocuments(store, USER_A);
    expect(docsA).toHaveLength(2);
    expect(docsA[0].id.startsWith('kbd_20260829')).toBe(true);

    const docsB = await listKnowledgeDocuments(store, USER_B);
    expect(docsB).toHaveLength(1);
    expect(docsB[0].resourceId).toBe(USER_B);
  });

  it('collapses foreign reads to not-found', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    await expect(getKnowledgeDocument(store, USER_B, metadata.id)).rejects.toThrow(ObjectStorageError);
  });

  it('guards status transitions through processing to ready and failed', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));

    await beginKnowledgeDocumentIngestion(store, USER_A, metadata.id);
    const ready = await completeKnowledgeDocumentIngestion(
      store,
      USER_A,
      metadata.id,
      { chunkCount: 7, embeddingModel: 'test-embed' },
    );
    expect(ready.status).toBe('ready');
    expect(ready.chunkCount).toBe(7);
    expect(ready.embeddingModel).toBe('test-embed');
    expect(ready.extractedObjectKey).toContain('extracted.txt');

    // Ingestion from `ready` is rejected so accidental re-fires never wipe indexes.
    await expect(beginKnowledgeDocumentIngestion(store, USER_A, metadata.id)).rejects.toThrow(
      ObjectStorageError,
    );

    // A racing failure must never flip a healthy indexed document to `failed`.
    await expect(failKnowledgeDocumentIngestion(store, USER_A, metadata.id, 'boom')).rejects.toThrow(
      ObjectStorageError,
    );

    // A processing record can still fail and re-enter ingestion cleanly.
    const second = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([2]));
    await beginKnowledgeDocumentIngestion(store, USER_A, second.id);
    const failed = await failKnowledgeDocumentIngestion(store, USER_A, second.id, 'boom');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
    const restarted = await beginKnowledgeDocumentIngestion(store, USER_A, second.id);
    expect(restarted.status).toBe('processing');
    expect(restarted.error).toBeUndefined();
  });

  it('refuses to re-begin ingestion while a processing run is fresh', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    await beginKnowledgeDocumentIngestion(store, USER_A, metadata.id);

    // Fresh processing: another run may not take over.
    await expect(beginKnowledgeDocumentIngestion(store, USER_A, metadata.id)).rejects.toMatchObject({
      code: 'already-exists',
    } satisfies Partial<ObjectStorageError>);

    // Past the stale window: crash recovery may take over.
    const late = new Date(Date.now() + KNOWLEDGE_STALE_PROCESSING_MS + 1);
    const restarted = await beginKnowledgeDocumentIngestion(store, USER_A, metadata.id, { now: () => late });
    expect(restarted.status).toBe('processing');
  });

  it('bounds the persisted failure reason', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    const failed = await failKnowledgeDocumentIngestion(store, USER_A, metadata.id, 'x'.repeat(900));
    expect((failed.error as string).length).toBeLessThanOrEqual(500);
  });

  it('collapses control characters in filenames before persisting', () => {
    const built = buildKnowledgeDocument(
      { resourceId: USER_A, filename: 'notes\u0000\u001f draft\t.md', mimeType: 'text/markdown', kind: 'text' },
      new Uint8Array([1]),
    );
    expect(built.metadata.filename).toBe('notes draft .md');
  });

  it('counts documents for the per-user cap', async () => {
    const store = createMemoryStorage();
    await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([2]));
    await expect(countKnowledgeDocuments(store, USER_A)).resolves.toBe(2);
    await expect(countKnowledgeDocuments(store, USER_B)).resolves.toBe(0);
  });
});

describe('knowledge document deletion', () => {
  it('deletes extraction, original, then metadata last', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    await store.createText(`kb/users/${USER_A}/documents/${metadata.id}/extracted.txt`, 'text');

    await deleteKnowledgeDocumentObjects(store, USER_A, metadata.id);

    expect(store.deleted).toEqual([
      `kb/users/${USER_A}/documents/${metadata.id}/extracted.txt`,
      metadata.storageKey,
      `kb/users/${USER_A}/documents/${metadata.id}/metadata.json`,
    ]);
    await expect(getKnowledgeDocument(store, USER_A, metadata.id)).rejects.toThrow(ObjectStorageError);
  });

  it('is idempotent when objects are already gone', async () => {
    const store = createMemoryStorage();
    const metadata = await saveKnowledgeDocument(store, uploadInput(), new Uint8Array([1]));
    await deleteKnowledgeDocumentObjects(store, USER_A, metadata.id);
    await expect(deleteKnowledgeDocumentObjects(store, USER_A, metadata.id)).resolves.toBeUndefined();
  });
});

describe('stale processing window', () => {
  it('exposes the shared stale constant', () => {
    expect(KNOWLEDGE_STALE_PROCESSING_MS).toBe(15 * 60 * 1000);
  });
});

describe('pure builder key layout', () => {
  it('computes original key from the sanitized extension', () => {
    const built = buildKnowledgeDocument(
      { resourceId: USER_A, filename: 'notes.md', mimeType: 'text/markdown', kind: 'text' },
      new Uint8Array([1]),
    );
    expect(built.originalObjectKey).toBe(`${built.metadata.storageKey}`);
    expect(built.metadata.storageKey.endsWith('/original.md')).toBe(true);
    expect(built.metadataObjectKey.endsWith('/metadata.json')).toBe(true);
  });
});
