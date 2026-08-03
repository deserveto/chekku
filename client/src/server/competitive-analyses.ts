import 'server-only';

import {
  createCompetitiveAnalysisStorage,
  createLazyGarageObjectStorage,
  createShareToken,
  getCompetitiveAnalysis,
  getShareToken,
  getShareableSlides,
  listCompetitiveAnalyses,
  ObjectStorageError,
  type CompetitiveAnalysisMetadata,
  type CompetitiveAnalysisReadResult,
  type ObjectStorage,
  type ShareTokenBundle,
  type ShareableSlidesPayload,
} from '@chekku/storage';

import { getUserId as getServerUserId } from './auth';

const ANALYSIS_ID_RE = /^pca_[0-9]{14}_[0-9a-f]{8}$/;

export type CompetitiveAnalysisServiceErrorCode =
  | 'forbidden'
  | 'invalid-analysis-id'
  | 'not-found'
  | 'storage-unavailable';

export class CompetitiveAnalysisServiceError extends Error {
  constructor(
    readonly code: CompetitiveAnalysisServiceErrorCode,
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'CompetitiveAnalysisServiceError';
  }
}

export interface CompetitiveAnalysisServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  listAnalyses?: (store: ObjectStorage) => Promise<CompetitiveAnalysisMetadata[]>;
  getAnalysis?: (
    store: ObjectStorage,
    analysisId: string,
  ) => Promise<CompetitiveAnalysisReadResult>;
  createShareToken?: (
    store: ObjectStorage,
    analysisId: string,
    anchorProduct: string,
  ) => Promise<ShareTokenBundle>;
  getShareToken?: (
    store: ObjectStorage,
    analysisId: string,
  ) => Promise<ShareTokenBundle | undefined>;
  getShareableSlides?: (
    store: ObjectStorage,
    analysisId: string,
    token: string,
  ) => Promise<ShareableSlidesPayload | undefined>;
}

export interface PublicSlidesPayload {
  analysisId: string;
  anchorProduct: string;
  createdAt: string;
  slidesMarkdown: string;
}

async function requireIdentity(resolveUserId: () => Promise<string | null>): Promise<void> {
  if (!await resolveUserId()) {
    throw new CompetitiveAnalysisServiceError(
      'forbidden',
      403,
      'Authentication is required.',
    );
  }
}

function mapStorageError(error: ObjectStorageError): CompetitiveAnalysisServiceError {
  if (error.code === 'not-found') {
    return new CompetitiveAnalysisServiceError(
      'not-found',
      404,
      'Competitive analysis not found.',
    );
  }
  return new CompetitiveAnalysisServiceError(
    'storage-unavailable',
    503,
    'Competitive analysis storage is unavailable.',
  );
}

function competitiveStore(dependencies: CompetitiveAnalysisServiceDependencies): ObjectStorage {
  const rootStoreFactory = dependencies.rootStoreFactory ?? createLazyGarageObjectStorage;
  return createCompetitiveAnalysisStorage(rootStoreFactory());
}

export async function listCompetitiveAnalysesForUser(
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<CompetitiveAnalysisMetadata[]> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  try {
    return await (dependencies.listAnalyses ?? listCompetitiveAnalyses)(
      competitiveStore(dependencies),
    );
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getCompetitiveAnalysisForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<CompetitiveAnalysisReadResult> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new CompetitiveAnalysisServiceError(
      'invalid-analysis-id',
      400,
      'Invalid analysis id.',
    );
  }

  try {
    return await (dependencies.getAnalysis ?? getCompetitiveAnalysis)(
      competitiveStore(dependencies),
      analysisId,
    );
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function createShareLinkForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<{ url: string }> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new CompetitiveAnalysisServiceError(
      'invalid-analysis-id',
      400,
      'Invalid analysis id.',
    );
  }
  try {
    const store = competitiveStore(dependencies);
    const analysis = await (dependencies.getAnalysis ?? getCompetitiveAnalysis)(
      store,
      analysisId,
    );
    const bundle = await (dependencies.createShareToken ?? createShareToken)(
      store,
      analysisId,
      analysis.metadata.anchorProduct,
    );
    const url = `/public/slides/${encodeURIComponent(analysisId)}?t=${bundle.token}`;
    return { url };
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getShareTokenForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<{ shared: boolean }> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new CompetitiveAnalysisServiceError(
      'invalid-analysis-id',
      400,
      'Invalid analysis id.',
    );
  }
  try {
    const store = competitiveStore(dependencies);
    const bundle = await (dependencies.getShareToken ?? getShareToken)(store, analysisId);
    return { shared: bundle !== undefined };
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getPublicSlides(
  analysisId: string,
  token: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<PublicSlidesPayload> {
  if (!ANALYSIS_ID_RE.test(analysisId) || typeof token !== 'string' || token.length === 0) {
    throw new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.');
  }
  try {
    const store = competitiveStore(dependencies);
    const payload = await (dependencies.getShareableSlides ?? getShareableSlides)(
      store,
      analysisId,
      token,
    );
    if (!payload) {
      throw new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.');
    }
    return { analysisId, ...payload };
  } catch (error) {
    if (error instanceof CompetitiveAnalysisServiceError) throw error;
    if (error instanceof ObjectStorageError) {
      throw new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.');
    }
    throw error;
  }
}
