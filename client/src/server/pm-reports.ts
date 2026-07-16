import 'server-only';

import {
  createLazyGarageObjectStorage,
  createPmReportStorage,
  getPmReport,
  listPmReports,
  ObjectStorageError,
  type ObjectStorage,
  type PmReportMetadata,
  type PmReportReadResult,
} from '@chekku/storage';

import { getUserId as getServerUserId } from './auth';

const REPORT_ID_RE = /^pmr_[a-zA-Z0-9_-]+$/;

export type PmReportServiceErrorCode =
  | 'forbidden'
  | 'invalid-report-id'
  | 'not-found'
  | 'storage-unavailable';

export class PmReportServiceError extends Error {
  constructor(
    readonly code: PmReportServiceErrorCode,
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'PmReportServiceError';
  }
}

export interface PmReportServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  listReports?: (store: ObjectStorage) => Promise<PmReportMetadata[]>;
  getReport?: (store: ObjectStorage, reportId: string) => Promise<PmReportReadResult>;
}

async function requireIdentity(resolveUserId: () => Promise<string | null>): Promise<void> {
  if (!await resolveUserId()) {
    throw new PmReportServiceError('forbidden', 403, 'Authentication is required.');
  }
}

function mapStorageError(error: ObjectStorageError): PmReportServiceError {
  if (error.code === 'not-found') {
    return new PmReportServiceError('not-found', 404, 'Report not found.');
  }
  return new PmReportServiceError(
    'storage-unavailable',
    503,
    'Report storage is unavailable.',
  );
}

function pmStore(dependencies: PmReportServiceDependencies): ObjectStorage {
  const rootStoreFactory = dependencies.rootStoreFactory ?? createLazyGarageObjectStorage;
  return createPmReportStorage(rootStoreFactory());
}

export async function listPmReportsForUser(
  dependencies: PmReportServiceDependencies = {},
): Promise<PmReportMetadata[]> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  try {
    return await (dependencies.listReports ?? listPmReports)(pmStore(dependencies));
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getPmReportForUser(
  reportId: string,
  dependencies: PmReportServiceDependencies = {},
): Promise<PmReportReadResult> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!REPORT_ID_RE.test(reportId)) {
    throw new PmReportServiceError('invalid-report-id', 400, 'Invalid report id.');
  }

  try {
    return await (dependencies.getReport ?? getPmReport)(pmStore(dependencies), reportId);
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}
