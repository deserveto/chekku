import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn<() => Promise<string | null>>(),
  getDownstreamToken: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@/server/auth', () => ({
  getUserId: mocks.getUserId,
  getDownstreamToken: mocks.getDownstreamToken,
}));

vi.mock('./auth', () => ({
  getUserId: mocks.getUserId,
  getDownstreamToken: mocks.getDownstreamToken,
}));

import { ObjectStorageError, type BinaryObjectStorage } from '@chekku/storage';

import {
  KnowledgeServiceError,
  deleteKnowledgeDocumentForUser,
  getKnowledgeDocumentForUser,
  isKnowledgeRetryEligible,
  listKnowledgeDocumentsForUser,
  readKnowledgeDocumentOriginalForUser,
  retryKnowledgeDocumentIngestionForUser,
  uploadKnowledgeDocumentForUser,
  type KnowledgeServiceDependencies,
} from './knowledge';

const USER_A = 'user-a-identifier';
const USER_B = 'user-b-identifier';

function createRootStore(): BinaryObjectStorage {
  const objects = new Map<string, string>();
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  return {
    async createText(key, value) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      objects.set(key, value);
    },
    async replaceText(key, value) {
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

function createDeps(userId: string | null) {
  const store = createRootStore();
  const workflows: Array<{ userId: string; workflowId: string; inputData: Record<string, unknown> }> = [];
  const deps: KnowledgeServiceDependencies = {
    getServerUserId: async () => userId,
    rootStoreFactory: () => store,
    startWorkflow: async (uid, workflowId, inputData) => {
      workflows.push({ userId: uid, workflowId, inputData });
    },
    now: () => new Date('2026-08-28T12:00:00Z'),
  };
  return { deps, store, workflows };
}

const pdfFile = { name: 'handbook.pdf', type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) };

beforeEach(() => {
  mocks.getUserId.mockReset();
  mocks.getDownstreamToken.mockReset();
});

describe('knowledge service', () => {
  it('requires authentication for every operation', async () => {
    const { deps } = createDeps(null);
    await expect(listKnowledgeDocumentsForUser(deps)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    } satisfies Partial<KnowledgeServiceError>);
    await expect(
      uploadKnowledgeDocumentForUser({ file: pdfFile }, deps),
    ).rejects.toMatchObject({ code: 'forbidden' } satisfies Partial<KnowledgeServiceError>);
  });

  it('persists the raw document and fires the ingestion workflow with the session identity', async () => {
    const { deps, store, workflows } = createDeps(USER_A);
    const metadata = await uploadKnowledgeDocumentForUser(
      { file: pdfFile, sourceThreadId: 'main-agent-u1-thread' },
      deps,
    );

    expect(metadata.status).toBe('processing');
    expect(metadata.resourceId).toBe(USER_A);
    expect(metadata.storageKey.endsWith('/original.pdf')).toBe(true);
    expect(await store.getBytes(metadata.storageKey)).toMatchObject({ contentType: 'application/pdf' });
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      userId: USER_A,
      workflowId: 'knowledge-document-ingestion',
      inputData: { documentId: metadata.id, resourceId: USER_A },
    });
  });

  it('rejects unsupported and oversized uploads before touching storage', async () => {
    const { deps } = createDeps(USER_A);
    await expect(
      uploadKnowledgeDocumentForUser({ file: { name: 'photo.png', type: 'image/png', bytes: new Uint8Array([1]) } }, deps),
    ).rejects.toMatchObject({ code: 'invalid-document', status: 400 } satisfies Partial<KnowledgeServiceError>);
    await expect(
      uploadKnowledgeDocumentForUser(
        { file: { name: 'big.pdf', type: 'application/pdf', bytes: new Uint8Array(21 * 1024 * 1024) } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 413 } satisfies Partial<KnowledgeServiceError>);
  });

  it('marks the document failed when the ingestion trigger cannot start', async () => {
    const failingDeps: KnowledgeServiceDependencies = {
      ...createDeps(USER_A).deps,
      startWorkflow: async () => {
        throw new Error('create-run failed with status 503');
      },
    };
    const metadata = await uploadKnowledgeDocumentForUser({ file: pdfFile }, failingDeps);
    expect(metadata.status).toBe('failed');
    expect(metadata.error).toContain('could not be started');
  });

  it('enforces tenant isolation: user B cannot list, read, open, or delete user A documents', async () => {
    const owner = createDeps(USER_A);
    const metadata = await uploadKnowledgeDocumentForUser({ file: pdfFile }, owner.deps);

    const intruder = createDeps(USER_B);
    await expect(
      getKnowledgeDocumentForUser(metadata.id, intruder.deps),
    ).rejects.toMatchObject({ code: 'not-found', status: 404 } satisfies Partial<KnowledgeServiceError>);
    await expect(
      readKnowledgeDocumentOriginalForUser(metadata.id, intruder.deps),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<KnowledgeServiceError>);
    await expect(
      deleteKnowledgeDocumentForUser(metadata.id, intruder.deps),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<KnowledgeServiceError>);
    await expect(listKnowledgeDocumentsForUser(intruder.deps)).resolves.toEqual([]);
    expect(intruder.workflows).toHaveLength(0);

    // The owner still sees exactly their own document.
    await expect(listKnowledgeDocumentsForUser(owner.deps)).resolves.toHaveLength(1);
  });

  it('fires the deletion workflow scoped to the session user', async () => {
    const { deps, workflows } = createDeps(USER_A);
    const metadata = await uploadKnowledgeDocumentForUser({ file: pdfFile }, deps);
    workflows.length = 0;

    await deleteKnowledgeDocumentForUser(metadata.id, deps);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      workflowId: 'knowledge-document-deletion',
      inputData: { documentId: metadata.id, resourceId: USER_A },
    });
  });

  it('returns the original bytes only to the owner', async () => {
    const { deps } = createDeps(USER_A);
    const metadata = await uploadKnowledgeDocumentForUser({ file: pdfFile }, deps);
    const bytes = await readKnowledgeDocumentOriginalForUser(metadata.id, deps);
    expect([...bytes.value]).toEqual([1, 2, 3]);
    expect(bytes.contentType).toBe('application/pdf');
  });
});

describe('retry eligibility', () => {
  it('allows failed documents and stale processing runs, not fresh ones', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    expect(isKnowledgeRetryEligible({ status: 'failed', updatedAt: now.toISOString() }, now)).toBe(true);
    expect(isKnowledgeRetryEligible({ status: 'processing', updatedAt: now.toISOString() }, now)).toBe(false);
    expect(
      isKnowledgeRetryEligible(
        { status: 'processing', updatedAt: new Date(now.getTime() - 16 * 60 * 1000).toISOString() },
        now,
      ),
    ).toBe(true);
    expect(isKnowledgeRetryEligible({ status: 'ready', updatedAt: now.toISOString() }, now)).toBe(false);
  });

  it('fires the retry workflow for failed documents and blocks fresh runs', async () => {
    const { deps, workflows } = createDeps(USER_A);
    const metadata = await uploadKnowledgeDocumentForUser({ file: pdfFile }, deps);

    // Fresh upload is `processing`: retry blocked.
    await expect(retryKnowledgeDocumentIngestionForUser(metadata.id, deps)).rejects.toMatchObject({
      code: 'retry-not-allowed',
      status: 409,
    } satisfies Partial<KnowledgeServiceError>);

    // Owner flips the record to failed server-side; retry now fires.
    const record = JSON.parse(
      await deps.rootStoreFactory!().getText(metadata.storageKey.replace('/original.pdf', '/metadata.json')),
    );
    record.status = 'failed';
    await deps.rootStoreFactory!().replaceText(
      metadata.storageKey.replace('/original.pdf', '/metadata.json'),
      JSON.stringify(record),
    );
    workflows.length = 0;
    await retryKnowledgeDocumentIngestionForUser(metadata.id, deps);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].workflowId).toBe('knowledge-document-ingestion');
  });
});
