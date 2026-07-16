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

vi.mock('@/server/pm-reports', async () => import('./pm-reports'));

import {
  ObjectStorageError,
  type ObjectStorage,
  type PmReportMetadata,
  type PmReportReadResult,
} from '@chekku/storage';

import { GET as getReportRoute } from '../app/api/storage/pm-reports/[reportId]/route';
import { GET as listReportsRoute } from '../app/api/storage/pm-reports/route';
import {
  getPmReportForUser,
  listPmReportsForUser,
  PmReportServiceError,
} from './pm-reports';

const reportId = 'pmr_20260714120000_deadbeef';
const metadata: PmReportMetadata = {
  reportId,
  createdAt: '2026-07-14T12:00:00.000Z',
  rating: 7,
  status: 'WARNING',
  inputObjectKey: `pm-reports/${reportId}/input.md`,
  analysisObjectKey: `pm-reports/${reportId}/analysis.md`,
  metadataObjectKey: `pm-reports/${reportId}/metadata.json`,
};
const report: PmReportReadResult = {
  reportId,
  inputMarkdown: '# Weekly report',
  analysisMarkdown: '# Analysis',
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

describe('PM report server service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('rejects missing identity before creating storage', async () => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const listReports = vi.fn(async () => [metadata]);

    await expect(listPmReportsForUser({
      getServerUserId: async () => null,
      rootStoreFactory,
      listReports,
    })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Authentication is required.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(listReports).not.toHaveBeenCalled();
  });

  it.each([
    'pmr_x',
    'pmr_-',
    'pmr_20260714120000_DEADBEEF',
    'pmr_20260714120000_deadbeef_extra',
    '../secret',
    `pmr_20260714120000_deadbeef%2Fsecret`,
    `pmr_20260714120000_deadbeef%5Csecret`,
  ])('rejects malformed report ID %s before resolving storage', async (malformedReportId) => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const getReport = vi.fn(async () => report);

    await expect(getPmReportForUser(malformedReportId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory,
      getReport,
    })).rejects.toMatchObject({
      code: 'invalid-report-id',
      status: 400,
      message: 'Invalid report id.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(getReport).not.toHaveBeenCalled();
  });

  it('lists reports through PM-namespaced injected root storage', async () => {
    const listKeys = vi.fn(async () => ({ keys: [], truncated: false }));
    const root = createRootStore({ listKeys });

    await expect(listPmReportsForUser({
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      listReports: async (store) => {
        await store.listKeys('pm-reports/');
        return [metadata];
      },
    })).resolves.toEqual([metadata]);
    expect(listKeys).toHaveBeenCalledWith('agents/cG0tYWdlbnQ/pm-reports/', undefined);
  });

  it('reads reports through PM-namespaced injected root storage', async () => {
    const getText = vi.fn(async () => 'content');
    const root = createRootStore({ getText });

    await expect(getPmReportForUser(reportId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      getReport: async (store, id) => {
        await store.getText(`pm-reports/${id}/input.md`);
        return report;
      },
    })).resolves.toEqual(report);
    expect(getText).toHaveBeenCalledWith(`agents/cG0tYWdlbnQ/pm-reports/${reportId}/input.md`);
  });

  it.each([
    ['not-found', 'not-found', 404, 'Report not found.'],
    ['configuration', 'storage-unavailable', 503, 'Report storage is unavailable.'],
    ['unavailable', 'storage-unavailable', 503, 'Report storage is unavailable.'],
    ['already-exists', 'storage-unavailable', 503, 'Report storage is unavailable.'],
  ] as const)('maps ObjectStorageError %s without leaking provider details', async (
    storageCode,
    serviceCode,
    status,
    message,
  ) => {
    const providerDetail = 'private endpoint request-id=secret';
    let failure: unknown;

    try {
      await getPmReportForUser(reportId, {
        getServerUserId: async () => 'user-1',
        rootStoreFactory: () => createRootStore(),
        getReport: async () => {
          throw new ObjectStorageError(storageCode, providerDetail);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PmReportServiceError);
    expect(failure).toMatchObject({ code: serviceCode, status, message });
    expect(String(failure)).not.toContain(providerDetail);
  });

});

describe('PM report API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('returns authenticated report lists from default PM-namespaced storage', async () => {
    const listKeys = vi.fn(async () => ({
      keys: [`agents/cG0tYWdlbnQ/${metadata.metadataObjectKey}`],
      truncated: false,
    }));
    const getText = vi.fn(async () => JSON.stringify(metadata));
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ listKeys, getText }));

    const response = await listReportsRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reports: [metadata] });
    expect(listKeys).toHaveBeenCalledWith('agents/cG0tYWdlbnQ/pm-reports/', undefined);
  });

  it('returns report detail', async () => {
    const getText = vi.fn(async (key: string) => key.endsWith('metadata.json')
      ? JSON.stringify(metadata)
      : key.endsWith('input.md') ? report.inputMarkdown : report.analysisMarkdown);
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ getText }));

    const response = await getReportRoute(new Request('http://localhost'), {
      params: Promise.resolve({ reportId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(report);
  });

  it('returns forbidden before resolving storage', async () => {
    mocks.getUserId.mockResolvedValue(null);

    const response = await listReportsRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'forbidden', message: 'Authentication is required.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it.each([
    'pmr_x',
    'pmr_-',
    'pmr_20260714120000_DEADBEEF',
    'pmr_20260714120000_deadbeef_extra',
    '../secret',
    `pmr_20260714120000_deadbeef%2Fsecret`,
    `pmr_20260714120000_deadbeef%5Csecret`,
  ])('returns 400 for malformed report ID %s before resolving storage', async (malformedReportId) => {
    const response = await getReportRoute(new Request('http://localhost'), {
      params: Promise.resolve({ reportId: malformedReportId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid-report-id', message: 'Invalid report id.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404, 'not-found', 'Report not found.'],
    ['configuration', 503, 'storage-unavailable', 'Report storage is unavailable.'],
  ] as const)('maps storage %s safely', async (storageCode, status, code, message) => {
    const providerDetail = 'bucket=https://private request-id=secret';
    mocks.rootStoreFactory.mockReturnValue(createRootStore({
      getText: vi.fn(async () => { throw new ObjectStorageError(storageCode, providerDetail); }),
    }));

    const response = await getReportRoute(new Request('http://localhost'), {
      params: Promise.resolve({ reportId }),
    });
    const body = await response.text();

    expect(response.status).toBe(status);
    expect(JSON.parse(body)).toEqual({ error: { code, message } });
    expect(body).not.toContain(providerDetail);
  });

  it('returns safe 500 for unknown failures', async () => {
    const providerDetail = 'raw provider failure';
    mocks.rootStoreFactory.mockImplementation(() => { throw new Error(providerDetail); });

    const response = await listReportsRoute();
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { code: 'internal-error', message: 'Could not load reports.' },
    });
    expect(body).not.toContain(providerDetail);
  });
});
