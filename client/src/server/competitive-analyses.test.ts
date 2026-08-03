import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn<() => Promise<string | null>>(),
  rootStoreFactory: vi.fn(),
}));

vi.mock('@/server/auth', () => ({
  getUserId: mocks.getUserId,
}));
vi.mock('./auth', () => ({
  getUserId: mocks.getUserId,
}));

vi.mock('@chekku/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chekku/storage')>();
  return {
    ...actual,
    createLazyGarageObjectStorage: mocks.rootStoreFactory,
  };
});

vi.mock('@/server/competitive-analyses', async () => import('./competitive-analyses'));

import {
  ObjectStorageError,
  type CompetitiveAnalysisMetadata,
  type CompetitiveAnalysisReadResult,
  type ObjectStorage,
} from '@chekku/storage';

import { GET as getAnalysisRoute } from '../app/api/storage/competitive-analyses/[analysisId]/route';
import { GET as listAnalysesRoute } from '../app/api/storage/competitive-analyses/route';
import {
  CompetitiveAnalysisServiceError,
  createShareLinkForUser,
  getCompetitiveAnalysisForUser,
  getPublicSlides,
  getShareTokenForUser,
  listCompetitiveAnalysesForUser,
  type PublicSlidesPayload,
} from './competitive-analyses';

const analysisId = 'pca_20260723120000_deadbeef';
const metadata: CompetitiveAnalysisMetadata = {
  analysisId,
  createdAt: '2026-07-23T12:00:00.000Z',
  anchorProduct: 'GPT',
  market: 'AI assistants',
  competitorNames: ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'],
  productCount: 6,
  sourceCount: 6,
  requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
  analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
  metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
};
const analysis: CompetitiveAnalysisReadResult = {
  analysisId,
  requestMarkdown: '/competitive-analysis GPT',
  analysisMarkdown: '# Competitive Analysis: GPT',
  slidesMarkdown: '---\nmarp: true\n---\n# Deck',
  metadata,
};

function createRootStore(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    createText: vi.fn(),
    replaceText: vi.fn(),
    getText: vi.fn(),
    exists: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(async () => ({ keys: [], truncated: false })),
    ...overrides,
  };
}

describe('competitive analysis server service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('rejects missing identity before creating storage', async () => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const listAnalyses = vi.fn(async () => [metadata]);

    await expect(listCompetitiveAnalysesForUser({
      getServerUserId: async () => null,
      rootStoreFactory,
      listAnalyses,
    })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Authentication is required.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(listAnalyses).not.toHaveBeenCalled();
  });

  it.each([
    'pca_x',
    'pca_-',
    'pca_20260723120000_DEADBEEF',
    'pca_20260723120000_deadbeef_extra',
    '../secret',
    'pca_20260723120000_deadbeef%2Fsecret',
    'pca_20260723120000_deadbeef%5Csecret',
  ])('rejects malformed analysis ID %s before resolving storage', async (malformedAnalysisId) => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const getAnalysis = vi.fn(async () => analysis);

    await expect(getCompetitiveAnalysisForUser(malformedAnalysisId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory,
      getAnalysis,
    })).rejects.toMatchObject({
      code: 'invalid-analysis-id',
      status: 400,
      message: 'Invalid analysis id.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(getAnalysis).not.toHaveBeenCalled();
  });

  it('lists analyses through PM-namespaced injected root storage', async () => {
    const listKeys = vi.fn(async () => ({ keys: [], truncated: false }));
    const root = createRootStore({ listKeys });

    await expect(listCompetitiveAnalysesForUser({
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      listAnalyses: async (store) => {
        await store.listKeys('competitive-analyses/');
        return [metadata];
      },
    })).resolves.toEqual([metadata]);
    expect(listKeys).toHaveBeenCalledWith(
      'agents/cG0tYWdlbnQ/competitive-analyses/',
      undefined,
    );
  });

  it('reads analyses through PM-namespaced injected root storage', async () => {
    const getText = vi.fn(async () => 'content');
    const root = createRootStore({ getText });

    await expect(getCompetitiveAnalysisForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      getAnalysis: async (store, id) => {
        await store.getText(`competitive-analyses/${id}/request.md`);
        return analysis;
      },
    })).resolves.toEqual(analysis);
    expect(getText).toHaveBeenCalledWith(
      `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/request.md`,
    );
  });

  it.each([
    ['not-found', 'not-found', 404, 'Competitive analysis not found.'],
    ['configuration', 'storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
    ['unavailable', 'storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
    ['already-exists', 'storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
  ] as const)('maps ObjectStorageError %s without leaking provider details', async (
    storageCode,
    serviceCode,
    status,
    message,
  ) => {
    const providerDetail = 'private endpoint request-id=secret';
    let failure: unknown;

    try {
      await getCompetitiveAnalysisForUser(analysisId, {
        getServerUserId: async () => 'user-1',
        rootStoreFactory: () => createRootStore(),
        getAnalysis: async () => {
          throw new ObjectStorageError(storageCode, providerDetail);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CompetitiveAnalysisServiceError);
    expect(failure).toMatchObject({ code: serviceCode, status, message });
    expect(String(failure)).not.toContain(providerDetail);
  });
});

describe('competitive analysis API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('returns authenticated analysis lists from default PM-namespaced storage', async () => {
    const listKeys = vi.fn(async () => ({
      keys: [`agents/cG0tYWdlbnQ/${metadata.metadataObjectKey}`],
      truncated: false,
    }));
    const getText = vi.fn(async () => JSON.stringify(metadata));
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ listKeys, getText }));

    const response = await listAnalysesRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ analyses: [metadata] });
    expect(listKeys).toHaveBeenCalledWith(
      'agents/cG0tYWdlbnQ/competitive-analyses/',
      undefined,
    );
  });

  it('projects hostile stored metadata through list and detail APIs', async () => {
    const hostileMetadata = {
      ...metadata,
      analysisUrl: 'https://attacker.example/analysis',
      analysesMarkdown: 'stolen',
      physicalObjectKey: 'agents/cG0tYWdlbnQ/private',
      nested: { arbitrary: ['secret'] },
    };
    const listKeys = vi.fn(async () => ({
      keys: [`agents/cG0tYWdlbnQ/${metadata.metadataObjectKey}`],
      truncated: false,
    }));
    const getText = vi.fn(async (key: string) => key.endsWith('metadata.json')
      ? JSON.stringify(hostileMetadata)
      : key.endsWith('request.md') ? analysis.requestMarkdown
      : key.endsWith('slides.md') ? analysis.slidesMarkdown
      : analysis.analysisMarkdown);
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ listKeys, getText }));

    const listResponse = await listAnalysesRoute();
    const detailResponse = await getAnalysisRoute(new Request('http://localhost'), {
      params: Promise.resolve({ analysisId }),
    });

    await expect(listResponse.json()).resolves.toEqual({ analyses: [metadata] });
    await expect(detailResponse.json()).resolves.toEqual(analysis);
  });

  it('returns forbidden before resolving storage', async () => {
    mocks.getUserId.mockResolvedValue(null);

    const response = await listAnalysesRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'forbidden', message: 'Authentication is required.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it('returns invalid ID before resolving storage', async () => {
    const response = await getAnalysisRoute(new Request('http://localhost'), {
      params: Promise.resolve({ analysisId: 'pca_legacy' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid-analysis-id', message: 'Invalid analysis id.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404, 'not-found', 'Competitive analysis not found.'],
    ['configuration', 503, 'storage-unavailable', 'Competitive analysis storage is unavailable.'],
  ] as const)('maps storage %s safely', async (storageCode, status, code, message) => {
    const providerDetail = 'bucket=https://private request-id=secret';
    mocks.rootStoreFactory.mockReturnValue(createRootStore({
      getText: vi.fn(async () => { throw new ObjectStorageError(storageCode, providerDetail); }),
    }));

    const response = await getAnalysisRoute(new Request('http://localhost'), {
      params: Promise.resolve({ analysisId }),
    });
    const body = await response.text();

    expect(response.status).toBe(status);
    expect(JSON.parse(body)).toEqual({ error: { code, message } });
    expect(body).not.toContain(providerDetail);
  });

  it.each([
    ['list', 'Could not load competitive analyses.'],
    ['detail', 'Could not load competitive analysis.'],
  ] as const)('returns safe 500 for unknown %s failures', async (route, message) => {
    const providerDetail = 'raw provider failure';
    mocks.rootStoreFactory.mockImplementation(() => { throw new Error(providerDetail); });

    const response = route === 'list'
      ? await listAnalysesRoute()
      : await getAnalysisRoute(new Request('http://localhost'), {
        params: Promise.resolve({ analysisId }),
      });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: 'internal-error', message } });
    expect(body).not.toContain(providerDetail);
  });
});

describe('share link lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
    mocks.rootStoreFactory.mockReturnValue(createRootStore());
  });

  it('createShareLinkForUser requires identity', async () => {
    await expect(createShareLinkForUser(analysisId, {
      getServerUserId: async () => null,
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('createShareLinkForUser rejects invalid analysis id', async () => {
    await expect(createShareLinkForUser('pca_legacy', {
      getServerUserId: async () => 'user-1',
    })).rejects.toMatchObject({ code: 'invalid-analysis-id', status: 400 });
  });

  it('createShareLinkForUser returns url after analysis read + token create', async () => {
    const getAnalysis = vi.fn(async () => analysis);
    const createShareToken = vi.fn(async () => ({
      token: 'abcdef0123456789abcdef0123456789',
      createdAt: '2026-07-29T10:00:00.000Z',
      anchorProduct: 'GPT',
    }));

    const result = await createShareLinkForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getAnalysis,
      createShareToken,
    });

    expect(getAnalysis).toHaveBeenCalledOnce();
    expect(createShareToken).toHaveBeenCalledWith(expect.anything(), analysisId, 'GPT');
    expect(result.url).toBe(`/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`);
  });

  it('createShareLinkForUser maps storage not-found to service not-found', async () => {
    const getAnalysis = vi.fn(async () => {
      throw new ObjectStorageError('not-found', 'missing');
    });

    await expect(createShareLinkForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getAnalysis,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
  });
});

describe('getShareTokenForUser status check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
    mocks.rootStoreFactory.mockReturnValue(createRootStore());
  });

  it('returns shared=false when no token exists', async () => {
    const getShareToken = vi.fn(async () => undefined);
    await expect(getShareTokenForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getShareToken,
    })).resolves.toEqual({ shared: false });
  });

  it('returns shared=true when token exists', async () => {
    const getShareToken = vi.fn(async () => ({
      token: 'a'.repeat(32),
      createdAt: '2026-07-29T10:00:00.000Z',
      anchorProduct: 'GPT',
    }));
    await expect(getShareTokenForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getShareToken,
    })).resolves.toEqual({ shared: true });
  });
});

describe('getPublicSlides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
    mocks.rootStoreFactory.mockReturnValue(createRootStore());
  });

  it('does NOT require identity', async () => {
    const getShareableSlides = vi.fn(async () => undefined);
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getServerUserId: async () => null,
      getShareableSlides,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
    expect(getShareableSlides).toHaveBeenCalledOnce();
  });

  it('throws not-found for invalid analysis id', async () => {
    await expect(getPublicSlides('pca_legacy', 'a'.repeat(32))).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
    });
  });

  it('throws not-found for empty token', async () => {
    await expect(getPublicSlides(analysisId, '')).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
    });
  });

  it('throws not-found when payload is undefined (token mismatch or missing)', async () => {
    const getShareableSlides = vi.fn(async () => undefined);
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getShareableSlides,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
  });

  it('maps storage not-found to service not-found', async () => {
    const getShareableSlides = vi.fn(async () => {
      throw new ObjectStorageError('not-found', 'missing');
    });
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getShareableSlides,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
  });

  it('maps storage-unavailable class errors to not-found (no leak)', async () => {
    const providerDetail = 'private endpoint request-id=secret';
    const getShareableSlides = vi.fn(async () => {
      throw new ObjectStorageError('unavailable', providerDetail);
    });
    let failure: unknown;
    try {
      await getPublicSlides(analysisId, 'a'.repeat(32), { getShareableSlides });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'not-found', status: 404 });
    expect(String(failure)).not.toContain(providerDetail);
  });

  it('returns payload when token validates', async () => {
    const getShareableSlides = vi.fn(async () => ({
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
      slidesMarkdown: '# Deck',
    }));
    const result: PublicSlidesPayload = await getPublicSlides(analysisId, 'a'.repeat(32), {
      getShareableSlides,
    });
    expect(result).toMatchObject({
      analysisId,
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
      slidesMarkdown: '# Deck',
    });
  });
});
