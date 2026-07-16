import { randomBytes } from 'node:crypto';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import type { ObjectStorage } from './objects.ts';

export const PM_REPORT_AGENT_ID = 'pm-agent';

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

export interface SavePmReportInput {
  store: ObjectStorage;
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

const HEADER_RE = /^[ \t]*(?:\*\*)?Risk Rating:[ \t]*(\d{1,2})[ \t]*\/[ \t]*10[ \t]*[—–-][ \t]*(ON-TRACK|WARNING|IN-DANGER)(?:\*\*)?[ \t]*$/m;
const REPORT_ID_RE = /^pmr_[0-9]{14}_[0-9a-f]{8}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export const createPmReportStorage = (root: ObjectStorage): ObjectStorage =>
  createNamespacedObjectStorage(root, PM_REPORT_AGENT_ID);

function statusForRating(rating: number): PmReportStatus {
  if (rating <= 3) return 'ON-TRACK';
  if (rating <= 7) return 'WARNING';
  return 'IN-DANGER';
}

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

  const status = match[2] as PmReportStatus;
  const expectedStatus = statusForRating(rating);
  if (status !== expectedStatus) {
    throw new Error(`Risk rating ${rating} requires status ${expectedStatus}, received ${status}`);
  }
  return { rating, status };
}

export function keysFor(reportId: string) {
  if (!REPORT_ID_RE.test(reportId)) {
    throw new Error(`Invalid PM report id: ${reportId}`);
  }
  const base = `pm-reports/${reportId}`;
  return {
    inputObjectKey: `${base}/input.md`,
    analysisObjectKey: `${base}/analysis.md`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}

export function parsePmReportTimestamp(value: string): number | undefined {
  const match = RFC3339_RE.exec(value);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offsetSign, offsetHourText = '0', offsetMinuteText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  const offset = (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = date.getTime() - (offsetSign === '+' ? offset : offsetSign === '-' ? -offset : 0);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function parsePmReportMetadata(value: unknown): PmReportMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.reportId !== 'string' || !REPORT_ID_RE.test(metadata.reportId)) return undefined;
  if (typeof metadata.createdAt !== 'string') return undefined;
  if (typeof metadata.rating !== 'number' || !Number.isInteger(metadata.rating) || metadata.rating < 1 || metadata.rating > 10) return undefined;
  const status = statusForRating(metadata.rating);
  if (metadata.status !== status) return undefined;

  const expectedKeys = keysFor(metadata.reportId);
  if (metadata.inputObjectKey !== expectedKeys.inputObjectKey
    || metadata.analysisObjectKey !== expectedKeys.analysisObjectKey
    || metadata.metadataObjectKey !== expectedKeys.metadataObjectKey) {
    return undefined;
  }

  return {
    reportId: metadata.reportId,
    createdAt: metadata.createdAt,
    rating: metadata.rating,
    status,
    ...expectedKeys,
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

  await input.store.createText(objectKeys.inputObjectKey, input.reportMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.analysisObjectKey, input.analysisMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.metadataObjectKey, JSON.stringify(metadata, null, 2), 'application/json');
  return metadata;
}

export async function listPmReports(store: ObjectStorage): Promise<PmReportMetadata[]> {
  const result = await store.listKeys('pm-reports/');
  if (result.truncated) {
    throw new Error('Cannot list all PM reports: object storage truncated the pm-reports/ listing. Increase the storage listing limit.');
  }
  const keys = result.keys.filter((key) => key.endsWith('/metadata.json'));
  const entries = await Promise.all(keys.map(async (key) => {
    const metadataText = await store.getText(key);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      return undefined;
    }
    const parsed = parsePmReportMetadata(metadata);
    return parsed?.metadataObjectKey === key ? parsed : undefined;
  }));
  const reports = entries.filter((entry): entry is PmReportMetadata => entry !== undefined);

  return reports
    .map((report, index) => ({ report, index, timestamp: parsePmReportTimestamp(report.createdAt) }))
    .sort((a, b) => {
      if (a.timestamp === undefined && b.timestamp === undefined) return a.index - b.index;
      if (a.timestamp === undefined) return 1;
      if (b.timestamp === undefined) return -1;
      return b.timestamp - a.timestamp || a.index - b.index;
    })
    .map(({ report }) => report);
}

export async function getPmReport(store: ObjectStorage, reportId: string): Promise<PmReportReadResult> {
  const objectKeys = keysFor(reportId);
  const [inputMarkdown, analysisMarkdown, metadataText] = await Promise.all([
    store.getText(objectKeys.inputObjectKey),
    store.getText(objectKeys.analysisObjectKey),
    store.getText(objectKeys.metadataObjectKey),
  ]);

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error(`Invalid PM report metadata for ${reportId}`);
  }
  const parsed = parsePmReportMetadata(metadata);
  if (!parsed || parsed.reportId !== reportId) {
    throw new Error(`Invalid PM report metadata for ${reportId}`);
  }
  return { reportId, inputMarkdown, analysisMarkdown, metadata: parsed };
}
