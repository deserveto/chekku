import { randomBytes } from 'node:crypto';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import { ObjectStorageError, type ObjectStorage } from './objects.ts';
import { PM_REPORT_AGENT_ID, parsePmReportTimestamp } from './pm-reports.ts';

export interface CompetitiveAnalysisMetadata {
  analysisId: string;
  createdAt: string;
  anchorProduct: string;
  market?: string;
  competitorNames: string[];
  productCount: number;
  sourceCount: number;
  requestObjectKey: string;
  analysisObjectKey: string;
  metadataObjectKey: string;
}

export interface SaveCompetitiveAnalysisInput {
  store: ObjectStorage;
  requestMarkdown: string;
  analysisMarkdown: string;
  slidesMarkdown: string;
  anchorProduct: string;
  market?: string;
  competitorNames: string[];
  sourceCount: number;
  analysisId?: string;
  now?: () => Date;
}

export interface CompetitiveAnalysisReadResult {
  analysisId: string;
  requestMarkdown: string;
  analysisMarkdown: string;
  slidesMarkdown?: string;
  metadata: CompetitiveAnalysisMetadata;
}

export interface ShareTokenBundle {
  token: string;
  createdAt: string;
  anchorProduct: string;
}

export interface ShareableSlidesPayload {
  anchorProduct: string;
  createdAt: string;
  slidesMarkdown: string;
}

const ANALYSIS_ID_RE = /^pca_[0-9]{14}_[0-9a-f]{8}$/;
const MAX_MARKDOWN_BYTES = 262_144;
const MAX_NAME_BYTES = 256;
const MAX_MARKET_BYTES = 512;
const MAX_CREATED_AT_BYTES = 128;

export const createCompetitiveAnalysisStorage = (root: ObjectStorage): ObjectStorage =>
  createNamespacedObjectStorage(root, PM_REPORT_AGENT_ID);

export function createCompetitiveAnalysisId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `pca_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function competitiveAnalysisKeysFor(analysisId: string) {
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new Error(`Invalid competitive analysis id: ${analysisId}`);
  }
  const base = `competitive-analyses/${analysisId}`;
  return {
    requestObjectKey: `${base}/request.md`,
    analysisObjectKey: `${base}/analysis.md`,
    slidesObjectKey: `${base}/slides.md`,
    shareTokenObjectKey: `${base}/share-token.json`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}

function validateMarkdown(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error(`${field} exceeds ${MAX_MARKDOWN_BYTES} UTF-8 bytes`);
  }
}

function normalizeBoundedText(value: string, field: string, maxBytes: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

function normalizeProducts(
  anchorProduct: string,
  competitorNames: readonly string[],
): { anchorProduct: string; competitorNames: string[] } {
  const normalizedAnchor = normalizeBoundedText(anchorProduct, 'anchorProduct', MAX_NAME_BYTES);
  if (competitorNames.length < 5 || competitorNames.length > 7) {
    throw new Error('competitorNames must contain five to seven products');
  }
  const normalizedCompetitors = competitorNames.map((name, index) =>
    normalizeBoundedText(name, `competitorNames[${index}]`, MAX_NAME_BYTES));
  const seen = new Set([normalizedAnchor.toLowerCase()]);
  for (const competitor of normalizedCompetitors) {
    const normalizedKey = competitor.toLowerCase();
    if (seen.has(normalizedKey)) {
      throw new Error('anchorProduct and competitorNames must be unique case-insensitively');
    }
    seen.add(normalizedKey);
  }
  return { anchorProduct: normalizedAnchor, competitorNames: normalizedCompetitors };
}

function parseCompetitiveAnalysisMetadata(value: unknown): CompetitiveAnalysisMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.analysisId !== 'string' || !ANALYSIS_ID_RE.test(metadata.analysisId)) {
    return undefined;
  }
  if (typeof metadata.createdAt !== 'string'
    || metadata.createdAt.length === 0
    || Buffer.byteLength(metadata.createdAt, 'utf8') > MAX_CREATED_AT_BYTES
    || typeof metadata.anchorProduct !== 'string'
    || !Array.isArray(metadata.competitorNames)
    || !metadata.competitorNames.every((name) => typeof name === 'string')
    || typeof metadata.productCount !== 'number'
    || typeof metadata.sourceCount !== 'number') {
    return undefined;
  }

  let products: { anchorProduct: string; competitorNames: string[] };
  let market: string | undefined;
  try {
    products = normalizeProducts(metadata.anchorProduct, metadata.competitorNames as string[]);
    if (metadata.market !== undefined) {
      if (typeof metadata.market !== 'string') return undefined;
      market = normalizeBoundedText(metadata.market, 'market', MAX_MARKET_BYTES);
    }
  } catch {
    return undefined;
  }

  const productCount = products.competitorNames.length + 1;
  if (!Number.isInteger(metadata.productCount)
    || metadata.productCount !== productCount
    || !Number.isInteger(metadata.sourceCount)
    || metadata.sourceCount !== productCount) {
    return undefined;
  }

  const expectedKeys = competitiveAnalysisKeysFor(metadata.analysisId);
  if (metadata.requestObjectKey !== expectedKeys.requestObjectKey
    || metadata.analysisObjectKey !== expectedKeys.analysisObjectKey
    || metadata.metadataObjectKey !== expectedKeys.metadataObjectKey) {
    return undefined;
  }

  return {
    analysisId: metadata.analysisId,
    createdAt: metadata.createdAt,
    anchorProduct: products.anchorProduct,
    ...(market === undefined ? {} : { market }),
    competitorNames: products.competitorNames,
    productCount,
    sourceCount: productCount,
    requestObjectKey: expectedKeys.requestObjectKey,
    analysisObjectKey: expectedKeys.analysisObjectKey,
    metadataObjectKey: expectedKeys.metadataObjectKey,
  };
}

export async function saveCompetitiveAnalysis(
  input: SaveCompetitiveAnalysisInput,
): Promise<CompetitiveAnalysisMetadata> {
  validateMarkdown(input.requestMarkdown, 'requestMarkdown');
  validateMarkdown(input.analysisMarkdown, 'analysisMarkdown');
  validateMarkdown(input.slidesMarkdown, 'slidesMarkdown');
  const products = normalizeProducts(input.anchorProduct, input.competitorNames);
  const market = input.market === undefined
    ? undefined
    : normalizeBoundedText(input.market, 'market', MAX_MARKET_BYTES);
  const productCount = products.competitorNames.length + 1;
  if (!Number.isInteger(input.sourceCount) || input.sourceCount !== productCount) {
    throw new Error('sourceCount must equal the number of analyzed products');
  }

  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const analysisId = input.analysisId ?? createCompetitiveAnalysisId(new Date(createdAt));
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const metadata: CompetitiveAnalysisMetadata = {
    analysisId,
    createdAt,
    anchorProduct: products.anchorProduct,
    ...(market === undefined ? {} : { market }),
    competitorNames: products.competitorNames,
    productCount,
    sourceCount: productCount,
    requestObjectKey: objectKeys.requestObjectKey,
    analysisObjectKey: objectKeys.analysisObjectKey,
    metadataObjectKey: objectKeys.metadataObjectKey,
  };

  await input.store.createText(objectKeys.requestObjectKey, input.requestMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.analysisObjectKey, input.analysisMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.slidesObjectKey, input.slidesMarkdown, 'text/markdown');
  await input.store.createText(
    objectKeys.metadataObjectKey,
    JSON.stringify(metadata, null, 2),
    'application/json',
  );
  return metadata;
}

export async function listCompetitiveAnalyses(
  store: ObjectStorage,
): Promise<CompetitiveAnalysisMetadata[]> {
  const result = await store.listKeys('competitive-analyses/');
  if (result.truncated) {
    throw new Error(
      'Cannot list all competitive analyses: object storage truncated the competitive-analyses/ listing. Increase the storage listing limit.',
    );
  }
  const metadataKeys = result.keys.filter((key) => key.endsWith('/metadata.json'));
  const entries = await Promise.all(metadataKeys.map(async (key) => {
    const metadataText = await store.getText(key);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      return undefined;
    }
    const parsed = parseCompetitiveAnalysisMetadata(metadata);
    return parsed?.metadataObjectKey === key ? parsed : undefined;
  }));

  return entries
    .filter((entry): entry is CompetitiveAnalysisMetadata => entry !== undefined)
    .map((analysis, index) => ({
      analysis,
      index,
      timestamp: parsePmReportTimestamp(analysis.createdAt),
    }))
    .sort((a, b) => {
      if (a.timestamp === undefined && b.timestamp === undefined) return a.index - b.index;
      if (a.timestamp === undefined) return 1;
      if (b.timestamp === undefined) return -1;
      return b.timestamp - a.timestamp || a.index - b.index;
    })
    .map(({ analysis }) => analysis);
}

export async function getCompetitiveAnalysis(
  store: ObjectStorage,
  analysisId: string,
): Promise<CompetitiveAnalysisReadResult> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const [requestMarkdown, analysisMarkdown, metadataText] = await Promise.all([
    store.getText(objectKeys.requestObjectKey),
    store.getText(objectKeys.analysisObjectKey),
    store.getText(objectKeys.metadataObjectKey),
  ]);

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error(`Invalid competitive analysis metadata for ${analysisId}`);
  }
  const parsed = parseCompetitiveAnalysisMetadata(metadata);
  if (!parsed || parsed.analysisId !== analysisId) {
    throw new Error(`Invalid competitive analysis metadata for ${analysisId}`);
  }

  let slidesMarkdown: string | undefined;
  try {
    slidesMarkdown = await store.getText(objectKeys.slidesObjectKey);
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') {
      slidesMarkdown = undefined;
    } else {
      throw error;
    }
  }

  return { analysisId, requestMarkdown, analysisMarkdown, slidesMarkdown, metadata: parsed };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseShareTokenBundle(raw: unknown): ShareTokenBundle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.token !== 'string' || typeof value.createdAt !== 'string'
    || typeof value.anchorProduct !== 'string') {
    return undefined;
  }
  if (!/^[0-9a-f]{32}$/.test(value.token)) return undefined;
  if (value.createdAt.length === 0 || value.createdAt.length > MAX_CREATED_AT_BYTES) return undefined;
  return {
    token: value.token,
    createdAt: value.createdAt,
    anchorProduct: value.anchorProduct,
  };
}

export async function createShareToken(
  store: ObjectStorage,
  analysisId: string,
  anchorProduct: string,
  now: () => Date = () => new Date(),
): Promise<ShareTokenBundle> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const normalizedAnchor = normalizeBoundedText(anchorProduct, 'anchorProduct', MAX_NAME_BYTES);
  let existing: ShareTokenBundle | undefined;
  try {
    const raw = await store.getText(objectKeys.shareTokenObjectKey);
    existing = parseShareTokenBundle(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.code !== 'not-found') {
      throw error;
    }
    existing = undefined;
  }
  if (existing) {
    if (existing.anchorProduct !== normalizedAnchor) {
      throw new Error('share-token anchorProduct mismatch');
    }
    return existing;
  }
  const bundle: ShareTokenBundle = {
    token: randomBytes(16).toString('hex'),
    createdAt: now().toISOString(),
    anchorProduct: normalizedAnchor,
  };
  await store.createText(
    objectKeys.shareTokenObjectKey,
    JSON.stringify(bundle, null, 2),
    'application/json',
  );
  return bundle;
}

export async function getShareToken(
  store: ObjectStorage,
  analysisId: string,
): Promise<ShareTokenBundle | undefined> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  let raw: string;
  try {
    raw = await store.getText(objectKeys.shareTokenObjectKey);
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseShareTokenBundle(parsed);
}

export async function getShareableSlides(
  store: ObjectStorage,
  analysisId: string,
  token: string,
): Promise<ShareableSlidesPayload | undefined> {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return undefined;
  const bundle = await getShareToken(store, analysisId);
  if (!bundle) return undefined;
  if (!timingSafeEqualHex(bundle.token, token)) return undefined;
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  try {
    const slidesMarkdown = await store.getText(objectKeys.slidesObjectKey);
    return {
      anchorProduct: bundle.anchorProduct,
      createdAt: bundle.createdAt,
      slidesMarkdown,
    };
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') return undefined;
    throw error;
  }
}
