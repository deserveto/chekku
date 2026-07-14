import { randomBytes } from 'node:crypto';

export type PmReportStatus = 'ON-TRACK' | 'WARNING' | 'IN-DANGER';

export interface PmReportMetadata {
  reportId: string;
  createdAt: string;
  rating: number;
  status: PmReportStatus;
  inputObjectKey: string;
  analysisObjectKey: string;
  metadataObjectKey: string;
}

export interface PmReportObjectStore {
  ensureReady?(): Promise<void>;
  putText(key: string, value: string, contentType: string): Promise<void>;
  getText(key: string): Promise<string>;
  listText?(prefix: string): Promise<string[]>;
}

export interface SavePmReportInput {
  store: PmReportObjectStore;
  reportMarkdown: string;
  analysisMarkdown: string;
  reportId?: string;
  now?: () => Date;
}

export interface PmReportReadResult {
  reportId: string;
  inputMarkdown: string;
  analysisMarkdown: string;
  metadata: PmReportMetadata;
}

const HEADER_RE = /Risk Rating:\s*(\d{1,2})\s*\/\s*10\s*[—–-]\s*(ON-TRACK|WARNING|IN-DANGER)/;

export function createReportId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `pmr_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function parseRiskHeader(markdown: string): { rating: number; status: PmReportStatus } {
  const match = markdown.match(HEADER_RE);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error('PM Agent output is missing a parseable risk rating header');
  }
  const rating = Number(match[1]);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    throw new Error('PM Agent output contains an invalid risk rating');
  }
  return { rating, status: match[2] as PmReportStatus };
}

export function keysFor(reportId: string) {
  const base = `pm-reports/${reportId}`;
  return {
    inputObjectKey: `${base}/input.md`,
    analysisObjectKey: `${base}/analysis.md`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}

export async function savePmReport(input: SavePmReportInput): Promise<PmReportMetadata> {
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const reportId = input.reportId ?? createReportId(new Date(createdAt));
  const parsed = parseRiskHeader(input.analysisMarkdown);
  const objectKeys = keysFor(reportId);
  const metadata: PmReportMetadata = {
    reportId,
    createdAt,
    rating: parsed.rating,
    status: parsed.status,
    ...objectKeys,
  };

  await input.store.putText(objectKeys.inputObjectKey, input.reportMarkdown, 'text/markdown');
  await input.store.putText(objectKeys.analysisObjectKey, input.analysisMarkdown, 'text/markdown');
  await input.store.putText(objectKeys.metadataObjectKey, JSON.stringify(metadata, null, 2), 'application/json');

  return metadata;
}

export async function listPmReports(store: PmReportObjectStore): Promise<PmReportMetadata[]> {
  if (!store.listText) {
    throw new Error('PM report store does not support listing reports');
  }

  const reports = (await store.listText('pm-reports/'))
    .map((text) => JSON.parse(text) as PmReportMetadata);

  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPmReport(store: PmReportObjectStore, reportId: string): Promise<PmReportReadResult> {
  const objectKeys = keysFor(reportId);
  const [inputMarkdown, analysisMarkdown, metadataText] = await Promise.all([
    store.getText(objectKeys.inputObjectKey),
    store.getText(objectKeys.analysisObjectKey),
    store.getText(objectKeys.metadataObjectKey),
  ]);
  return { reportId, inputMarkdown, analysisMarkdown, metadata: JSON.parse(metadataText) as PmReportMetadata };
}
