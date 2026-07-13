import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PmReportStatus = 'ON-TRACK' | 'WARNING' | 'IN-DANGER';

export interface PmReportMetadata {
  reportId: string;
  createdAt: string;
  rating: number;
  status: PmReportStatus;
  inputPath: string;
  analysisPath: string;
  metadataPath: string;
}

export interface SavePmReportInput {
  baseDir?: string;
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

export const defaultPmReportsDir = join(process.cwd(), 'pm-reports');

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

export function pathsFor(baseDir: string, reportId: string) {
  const reportDir = join(baseDir, reportId);
  return {
    reportDir,
    inputPath: join(reportDir, 'input.md'),
    analysisPath: join(reportDir, 'analysis.md'),
    metadataPath: join(reportDir, 'metadata.json'),
  };
}

export async function savePmReport(input: SavePmReportInput): Promise<PmReportMetadata> {
  const baseDir = input.baseDir ?? defaultPmReportsDir;
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const reportId = input.reportId ?? createReportId(new Date(createdAt));
  const parsed = parseRiskHeader(input.analysisMarkdown);
  const paths = pathsFor(baseDir, reportId);
  const metadata: PmReportMetadata = {
    reportId,
    createdAt,
    rating: parsed.rating,
    status: parsed.status,
    inputPath: paths.inputPath,
    analysisPath: paths.analysisPath,
    metadataPath: paths.metadataPath,
  };

  await mkdir(paths.reportDir, { recursive: true });
  await Promise.all([
    writeFile(paths.inputPath, input.reportMarkdown, 'utf8'),
    writeFile(paths.analysisPath, input.analysisMarkdown, 'utf8'),
    writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2), 'utf8'),
  ]);

  return metadata;
}

export async function listPmReports(baseDir = defaultPmReportsDir): Promise<PmReportMetadata[]> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const reports = await Promise.all(entries
    .filter((entry) => entry.startsWith('pmr_'))
    .map(async (entry) => JSON.parse(await readFile(join(baseDir, entry, 'metadata.json'), 'utf8')) as PmReportMetadata));

  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPmReport(baseDir: string = defaultPmReportsDir, reportId: string): Promise<PmReportReadResult> {
  const paths = pathsFor(baseDir, reportId);
  const [inputMarkdown, analysisMarkdown, metadataText] = await Promise.all([
    readFile(paths.inputPath, 'utf8'),
    readFile(paths.analysisPath, 'utf8'),
    readFile(paths.metadataPath, 'utf8'),
  ]);
  return { reportId, inputMarkdown, analysisMarkdown, metadata: JSON.parse(metadataText) as PmReportMetadata };
}
