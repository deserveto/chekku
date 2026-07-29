import { describe, expect, it } from 'vitest';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import {
  ObjectStorageError,
  type ObjectStorage,
} from './objects.ts';
import {
  competitiveAnalysisKeysFor,
  createCompetitiveAnalysisId,
  createCompetitiveAnalysisStorage,
  getCompetitiveAnalysis,
  listCompetitiveAnalyses,
  saveCompetitiveAnalysis,
} from './competitive-analyses.ts';

const analysisId = 'pca_20260723120000_deadbeef';
const requestMarkdown = '/competitive-analysis GPT vs Claude';
const analysisMarkdown = '# Competitive Analysis: GPT';
const competitorNames = ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'];

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const writes: Array<{ method: 'create' | 'replace'; key: string; value: string; contentType?: string }> = [];
  const storage: ObjectStorage = {
    async createText(key, value, contentType) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      writes.push({ method: 'create', key, value, contentType });
      objects.set(key, value);
    },
    async replaceText(key, value, contentType) {
      writes.push({ method: 'replace', key, value, contentType });
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return value;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async listKeys(prefix, options) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      const limit = options?.limit ?? keys.length;
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  return { objects, storage, writes };
}

const slidesMarkdown = '---\nmarp: true\n---\n# Deck\n';

function validInput(store: ObjectStorage) {
  return {
    store,
    requestMarkdown,
    analysisMarkdown,
    slidesMarkdown,
    anchorProduct: 'GPT',
    market: 'General AI assistants',
    competitorNames,
    sourceCount: 6,
    analysisId,
    now: () => new Date('2026-07-23T12:00:00.000Z'),
  };
}

describe('competitive analysis storage', () => {
  it('generates canonical IDs and derives canonical relative keys', () => {
    expect(createCompetitiveAnalysisId(new Date('2026-07-23T12:00:00.000Z'))).toMatch(
      /^pca_20260723120000_[0-9a-f]{8}$/,
    );
    expect(competitiveAnalysisKeysFor(analysisId)).toEqual({
      requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
      analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
      slidesObjectKey: `competitive-analyses/${analysisId}/slides.md`,
      metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
    });
  });

  it('writes through the PM namespace and round-trips approved fields', async () => {
    const { storage, writes } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    const metadata = await saveCompetitiveAnalysis(validInput(store));

    expect(metadata).toEqual({
      analysisId,
      createdAt: '2026-07-23T12:00:00.000Z',
      anchorProduct: 'GPT',
      market: 'General AI assistants',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
      analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
      metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
    });
    expect(metadata).not.toHaveProperty('slidesObjectKey');
    expect(writes.map(({ key }) => key)).toEqual([
      `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/request.md`,
      `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/analysis.md`,
      `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/slides.md`,
      `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/metadata.json`,
    ]);
    await expect(getCompetitiveAnalysis(store, analysisId)).resolves.toEqual({
      analysisId,
      requestMarkdown,
      analysisMarkdown,
      slidesMarkdown,
      metadata,
    });
  });

  it('writes request and analysis before metadata using createText', async () => {
    const { storage, writes } = createMemoryStorage();

    const metadata = await saveCompetitiveAnalysis(validInput(storage));

    expect(writes).toEqual([
      {
        method: 'create',
        key: `competitive-analyses/${analysisId}/request.md`,
        value: requestMarkdown,
        contentType: 'text/markdown',
      },
      {
        method: 'create',
        key: `competitive-analyses/${analysisId}/analysis.md`,
        value: analysisMarkdown,
        contentType: 'text/markdown',
      },
      {
        method: 'create',
        key: `competitive-analyses/${analysisId}/slides.md`,
        value: slidesMarkdown,
        contentType: 'text/markdown',
      },
      {
        method: 'create',
        key: `competitive-analyses/${analysisId}/metadata.json`,
        value: JSON.stringify(metadata, null, 2),
        contentType: 'application/json',
      },
    ]);
  });

  it('does not list request and analysis objects without metadata', async () => {
    const { storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    await storage.createText(keys.requestObjectKey, requestMarkdown);
    await storage.createText(keys.analysisObjectKey, analysisMarkdown);

    await expect(listCompetitiveAnalyses(storage)).resolves.toEqual([]);
  });

  it.each([
    ['analysis.md', [`competitive-analyses/${analysisId}/request.md`]],
    ['slides.md', [
      `competitive-analyses/${analysisId}/request.md`,
      `competitive-analyses/${analysisId}/analysis.md`,
    ]],
    ['metadata.json', [
      `competitive-analyses/${analysisId}/request.md`,
      `competitive-analyses/${analysisId}/analysis.md`,
      `competitive-analyses/${analysisId}/slides.md`,
    ]],
  ])('propagates %s write failures without exposing complete metadata', async (failedObject, persistedKeys) => {
    const { objects, storage } = createMemoryStorage();
    const failingStorage: ObjectStorage = {
      ...storage,
      async createText(key, value, contentType) {
        if (key.endsWith(`/${failedObject}`)) throw new Error(`Injected ${failedObject} failure`);
        await storage.createText(key, value, contentType);
      },
    };

    await expect(saveCompetitiveAnalysis(validInput(failingStorage))).rejects.toThrow(
      `Injected ${failedObject} failure`,
    );
    expect([...objects.keys()]).toEqual(persistedKeys);
    await expect(listCompetitiveAnalyses(storage)).resolves.toEqual([]);
  });

  it('isolates analyses from other agent namespaces', async () => {
    const { storage } = createMemoryStorage();
    const pmStore = createCompetitiveAnalysisStorage(storage);
    const foreignStore = createNamespacedObjectStorage(storage, 'other-agent');
    await saveCompetitiveAnalysis(validInput(pmStore));
    await saveCompetitiveAnalysis({
      ...validInput(foreignStore),
      analysisId: 'pca_20260723120100_cafebabe',
      anchorProduct: 'Foreign',
    });

    await expect(listCompetitiveAnalyses(pmStore)).resolves.toMatchObject([{ analysisId }]);
    await expect(
      getCompetitiveAnalysis(pmStore, 'pca_20260723120100_cafebabe'),
    ).rejects.toThrow('Missing object');
  });

  it('lists valid timestamps newest first and retains source order for invalid or equal instants', async () => {
    const { storage } = createMemoryStorage();
    const entries = [
      ['pca_20260723120000_00000001', 'invalid date'],
      ['pca_20260723120100_00000002', '2026-07-23T12:01:00.1239Z'],
      ['pca_20260723120200_00000003', 'not a date'],
      ['pca_20260723120300_00000004', '2026-07-23T12:01:00.1231Z'],
    ] as const;
    for (const [id, createdAt] of entries) {
      await saveCompetitiveAnalysis({
        ...validInput(storage),
        analysisId: id,
        now: () => ({ toISOString: () => createdAt }) as Date,
      });
    }

    expect((await listCompetitiveAnalyses(storage)).map(({ analysisId: id }) => id)).toEqual([
      'pca_20260723120100_00000002',
      'pca_20260723120300_00000004',
      'pca_20260723120000_00000001',
      'pca_20260723120200_00000003',
    ]);
  });

  it('rejects truncated listings', async () => {
    const { storage } = createMemoryStorage();
    const truncatedStorage: ObjectStorage = {
      ...storage,
      async listKeys() {
        return { keys: [], truncated: true };
      },
    };

    await expect(listCompetitiveAnalyses(truncatedStorage)).rejects.toThrow(
      'Cannot list all competitive analyses: object storage truncated the competitive-analyses/ listing. Increase the storage listing limit.',
    );
  });

  it('skips malformed, noncanonical, inconsistent, and wrong-path metadata', async () => {
    const { objects, storage } = createMemoryStorage();
    const validId = 'pca_20260723120400_00000005';
    const validKeys = competitiveAnalysisKeysFor(validId);
    const valid = {
      analysisId: validId,
      createdAt: '2026-07-23T12:04:00.000Z',
      anchorProduct: 'GPT',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      requestObjectKey: validKeys.requestObjectKey,
      analysisObjectKey: validKeys.analysisObjectKey,
      metadataObjectKey: validKeys.metadataObjectKey,
    };
    objects.set(validKeys.metadataObjectKey, JSON.stringify(valid));
    objects.set('competitive-analyses/corrupt/metadata.json', '{not-json');
    objects.set('competitive-analyses/pca_legacy/metadata.json', JSON.stringify({
      ...valid,
      analysisId: 'pca_legacy',
      requestObjectKey: 'competitive-analyses/pca_legacy/request.md',
      analysisObjectKey: 'competitive-analyses/pca_legacy/analysis.md',
      metadataObjectKey: 'competitive-analyses/pca_legacy/metadata.json',
    }));
    const wrongPathId = 'pca_20260723120500_00000006';
    objects.set(`competitive-analyses/${wrongPathId}/metadata.json`, JSON.stringify({
      ...valid,
      analysisId: wrongPathId,
      ...competitiveAnalysisKeysFor('pca_20260723120600_00000007'),
    }));
    const wrongCountId = 'pca_20260723120700_00000008';
    objects.set(`competitive-analyses/${wrongCountId}/metadata.json`, JSON.stringify({
      ...valid,
      analysisId: wrongCountId,
      productCount: 7,
      ...competitiveAnalysisKeysFor(wrongCountId),
    }));

    await expect(listCompetitiveAnalyses(storage)).resolves.toEqual([valid]);
  });

  it('projects untrusted metadata to approved fields for lists and reads', async () => {
    const { objects, storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    const approved = {
      analysisId,
      createdAt: '2026-07-23T12:00:00.000Z',
      anchorProduct: 'GPT',
      market: 'AI assistants',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      requestObjectKey: keys.requestObjectKey,
      analysisObjectKey: keys.analysisObjectKey,
      metadataObjectKey: keys.metadataObjectKey,
    };
    objects.set(keys.requestObjectKey, requestMarkdown);
    objects.set(keys.analysisObjectKey, analysisMarkdown);
    objects.set(keys.metadataObjectKey, JSON.stringify({
      ...approved,
      analysisUrl: 'https://attacker.example/',
      analysesMarkdown: 'stolen',
      physicalObjectKey: 'agents/cG0tYWdlbnQ/private',
      nested: { arbitrary: ['secret'] },
    }));

    await expect(listCompetitiveAnalyses(storage)).resolves.toEqual([approved]);
    await expect(getCompetitiveAnalysis(storage, analysisId)).resolves.toEqual({
      analysisId,
      requestMarkdown,
      analysisMarkdown,
      metadata: approved,
    });
  });

  it('rejects oversized stored timestamps from lists and direct reads', async () => {
    const { objects, storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    const oversized = {
      analysisId,
      createdAt: 'x'.repeat(129),
      anchorProduct: 'GPT',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      ...keys,
    };
    objects.set(keys.requestObjectKey, requestMarkdown);
    objects.set(keys.analysisObjectKey, analysisMarkdown);
    objects.set(keys.metadataObjectKey, JSON.stringify(oversized));

    await expect(listCompetitiveAnalyses(storage)).resolves.toEqual([]);
    await expect(getCompetitiveAnalysis(storage, analysisId)).rejects.toThrow(
      `Invalid competitive analysis metadata for ${analysisId}`,
    );
  });

  it.each([
    '../escape',
    'pca_bad/id',
    'analysis',
    'pca_',
    'pca_legacy',
    'pca_20260723120000_DEADBEEF',
    'pca_20260723120000_deadbeef_extra',
  ])('rejects invalid analysis id %s at every boundary', async (invalidId) => {
    const { storage, writes } = createMemoryStorage();
    expect(() => competitiveAnalysisKeysFor(invalidId)).toThrow(
      `Invalid competitive analysis id: ${invalidId}`,
    );
    await expect(saveCompetitiveAnalysis({
      ...validInput(storage),
      analysisId: invalidId,
    })).rejects.toThrow(`Invalid competitive analysis id: ${invalidId}`);
    await expect(getCompetitiveAnalysis(storage, invalidId)).rejects.toThrow(
      `Invalid competitive analysis id: ${invalidId}`,
    );
    expect(writes).toEqual([]);
  });

  it.each([
    ['duplicate anchor', { competitorNames: ['gpt', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'] }],
    ['duplicate competitors', { competitorNames: ['Claude', 'claude', 'Copilot', 'Perplexity', 'Meta AI'] }],
    ['four competitors', { competitorNames: competitorNames.slice(0, 4), sourceCount: 5 }],
    ['eight competitors', { competitorNames: [...competitorNames, 'A', 'B', 'C'], sourceCount: 9 }],
    ['source count mismatch', { sourceCount: 5 }],
    ['oversized anchor', { anchorProduct: 'a'.repeat(257) }],
    ['oversized competitor', { competitorNames: ['b'.repeat(257), ...competitorNames.slice(1)] }],
    ['oversized market', { market: 'm'.repeat(513) }],
    ['blank request', { requestMarkdown: '   ' }],
    ['blank analysis', { analysisMarkdown: '\n\t' }],
    ['blank anchor', { anchorProduct: ' ' }],
    ['blank competitor', { competitorNames: [' ', ...competitorNames.slice(1)] }],
  ])('rejects invalid save input: %s', async (_name, override) => {
    const { storage, writes } = createMemoryStorage();

    await expect(saveCompetitiveAnalysis({
      ...validInput(storage),
      ...override,
    })).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it.each([
    ['requestMarkdown', 'r'.repeat(262_145)],
    ['analysisMarkdown', 'a'.repeat(262_145)],
  ] as const)('rejects oversized %s before writing', async (field, value) => {
    const { storage, writes } = createMemoryStorage();

    await expect(saveCompetitiveAnalysis({
      ...validInput(storage),
      [field]: value,
    })).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('trims names and market before persistence', async () => {
    const { storage } = createMemoryStorage();

    const metadata = await saveCompetitiveAnalysis({
      ...validInput(storage),
      anchorProduct: ' GPT ',
      market: ' AI assistants ',
      competitorNames: competitorNames.map((name) => ` ${name} `),
    });

    expect(metadata).toMatchObject({
      anchorProduct: 'GPT',
      market: 'AI assistants',
      competitorNames,
    });
  });

  it('rejects invalid stored metadata on direct reads', async () => {
    const { objects, storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    objects.set(keys.requestObjectKey, requestMarkdown);
    objects.set(keys.analysisObjectKey, analysisMarkdown);
    objects.set(keys.metadataObjectKey, JSON.stringify({ analysisId }));

    await expect(getCompetitiveAnalysis(storage, analysisId)).rejects.toThrow(
      `Invalid competitive analysis metadata for ${analysisId}`,
    );
  });

  it('writes slides.md between analysis.md and metadata.json', async () => {
    const { storage, writes } = createMemoryStorage();

    await saveCompetitiveAnalysis(validInput(storage));

    const writeKeys = writes.map(({ key }) => key);
    const slidesIndex = writeKeys.indexOf(`competitive-analyses/${analysisId}/slides.md`);
    const analysisIndex = writeKeys.indexOf(`competitive-analyses/${analysisId}/analysis.md`);
    const metadataIndex = writeKeys.indexOf(`competitive-analyses/${analysisId}/metadata.json`);
    expect(slidesIndex).toBeGreaterThan(-1);
    expect(slidesIndex).toBeGreaterThan(analysisIndex);
    expect(metadataIndex).toBeGreaterThan(slidesIndex);
  });

  it('rejects blank slidesMarkdown before writing anything', async () => {
    const { storage, writes } = createMemoryStorage();

    await expect(saveCompetitiveAnalysis({
      ...validInput(storage),
      slidesMarkdown: '   ',
    })).rejects.toThrow('slidesMarkdown must not be blank');
    expect(writes).toEqual([]);
  });

  it('rejects oversized slidesMarkdown before writing', async () => {
    const { storage, writes } = createMemoryStorage();

    await expect(saveCompetitiveAnalysis({
      ...validInput(storage),
      slidesMarkdown: 's'.repeat(262_145),
    })).rejects.toThrow('slidesMarkdown exceeds 262144 UTF-8 bytes');
    expect(writes).toEqual([]);
  });

  it('round-trips slidesMarkdown on read', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    await saveCompetitiveAnalysis(validInput(store));

    const result = await getCompetitiveAnalysis(store, analysisId);
    expect(result.slidesMarkdown).toBe(slidesMarkdown);
  });

  it('returns slidesMarkdown undefined for legacy analyses without slides.md', async () => {
    const { objects, storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    const legacyMetadata = {
      analysisId,
      createdAt: '2026-07-23T12:00:00.000Z',
      anchorProduct: 'GPT',
      market: 'AI assistants',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      requestObjectKey: keys.requestObjectKey,
      analysisObjectKey: keys.analysisObjectKey,
      metadataObjectKey: keys.metadataObjectKey,
    };
    objects.set(keys.requestObjectKey, requestMarkdown);
    objects.set(keys.analysisObjectKey, analysisMarkdown);
    objects.set(keys.metadataObjectKey, JSON.stringify(legacyMetadata));

    const result = await getCompetitiveAnalysis(storage, analysisId);
    expect(result.slidesMarkdown).toBeUndefined();
  });

  it('propagates non-not-found storage errors when reading slides.md', async () => {
    const { objects, storage } = createMemoryStorage();
    const keys = competitiveAnalysisKeysFor(analysisId);
    const valid = {
      analysisId,
      createdAt: '2026-07-23T12:00:00.000Z',
      anchorProduct: 'GPT',
      competitorNames,
      productCount: 6,
      sourceCount: 6,
      ...keys,
    };
    objects.set(keys.requestObjectKey, requestMarkdown);
    objects.set(keys.analysisObjectKey, analysisMarkdown);
    objects.set(keys.metadataObjectKey, JSON.stringify(valid));
    const failingStorage: ObjectStorage = {
      ...storage,
      async getText(key) {
        if (key === keys.slidesObjectKey) {
          throw new ObjectStorageError('unavailable', 'injected outage');
        }
        return storage.getText(key);
      },
    };

    await expect(getCompetitiveAnalysis(failingStorage, analysisId)).rejects.toThrow('injected outage');
  });
});
