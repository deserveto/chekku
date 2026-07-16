import {
  createLazyGarageObjectStorage,
  createPmReportStorage,
  getPmReport,
  listPmReports,
  parsePmReportTimestamp,
  savePmReport,
  type ObjectStorage,
  type PmReportMetadata,
} from '@chekku/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const statusSchema = z.enum(['ON-TRACK', 'WARNING', 'IN-DANGER']);

const metadataSchema = z.object({
  reportId: z.string(),
  createdAt: z.string(),
  rating: z.number().int().min(1).max(10),
  status: statusSchema,
  inputObjectKey: z.string(),
  analysisObjectKey: z.string(),
  metadataObjectKey: z.string(),
}).strict();

const listMetadataSchema = metadataSchema.extend({
  reportUrl: z.string(),
}).strict();

type PmReportListItem = PmReportMetadata & { reportUrl: string };

function escapeMarkdownCell(value: string): string {
  const controlCharacter = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const escapeAllPunctuation = controlCharacter.test(value) || /https?:\/\//i.test(value);
  const visibleEscapes: Record<string, string> = {
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\v': '\\v',
    '\f': '\\f',
    '\r': '\\r',
  };

  return Array.from(value, (character) => {
    if (character === '\\') return '\\\\';
    if (character === '|') return '\\|';
    if (controlCharacter.test(character)) {
      return visibleEscapes[character]
        ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
    if (/[!\[\]()<>]/.test(character) || (escapeAllPunctuation && /[!-/:-@\[-`{-~]/.test(character))) {
      return `\\${character}`;
    }
    return character;
  }).join('');
}

function formatCreatedAt(createdAt: string): string {
  const timestamp = parsePmReportTimestamp(createdAt);
  if (timestamp === undefined) return escapeMarkdownCell(createdAt);
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatPmReportsMarkdown(reports: readonly PmReportListItem[]): string {
  if (reports.length === 0) return 'No saved reports found.';
  const rows = reports.map((report) =>
    `| [${escapeMarkdownCell(report.reportId)}](${report.reportUrl}) | ${formatCreatedAt(report.createdAt)} | ${report.rating}/10 | ${report.status} |`,
  );
  return [
    '| Report | Created | Risk | Status |',
    '| --- | --- | ---: | --- |',
    ...rows,
  ].join('\n');
}

export interface PmReportToolOptions {
  storeFactory?: () => ObjectStorage;
  now?: () => Date;
}

function reportStore(options: PmReportToolOptions): ObjectStorage {
  return createPmReportStorage((options.storeFactory ?? createLazyGarageObjectStorage)());
}

export function createSavePmReportToGarageTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'save_pm_report_to_garage',
    description: 'Save a PM Agent weekly report analysis to Garage object storage and return its metadata.',
    inputSchema: z.object({
      reportMarkdown: z.string().trim().min(1),
      analysisMarkdown: z.string().trim().min(1),
    }).strict(),
    outputSchema: metadataSchema,
    execute: async ({ reportMarkdown, analysisMarkdown }) => {
      const store = reportStore(options);
      await store.ensureReady?.();
      return savePmReport({
        store,
        reportMarkdown,
        analysisMarkdown,
        ...(options.now ? { now: options.now } : {}),
      });
    },
  });
}

export function createListPmReportsFromGarageTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'list_pm_reports_from_garage',
    description: 'List PM Agent reports saved in Garage, newest first.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      reports: z.array(listMetadataSchema),
      reportsMarkdown: z.string(),
    }).strict(),
    execute: async () => {
      const store = reportStore(options);
      await store.ensureReady?.();
      const reports = (await listPmReports(store)).map((report) => ({
        ...report,
        reportUrl: `/reports/${encodeURIComponent(report.reportId)}`,
      }));
      return { reports, reportsMarkdown: formatPmReportsMarkdown(reports) };
    },
  });
}

export function createViewPmReportFromGarageTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'view_pm_report_from_garage',
    description: 'View a saved PM Agent report from Garage by report id.',
    inputSchema: z.object({
      reportId: z.string().regex(/^pmr_[a-zA-Z0-9_-]+$/),
    }).strict(),
    outputSchema: z.object({
      reportId: z.string(),
      inputMarkdown: z.string(),
      analysisMarkdown: z.string(),
      metadata: metadataSchema,
    }).strict(),
    execute: async ({ reportId }) => {
      const store = reportStore(options);
      await store.ensureReady?.();
      return getPmReport(store, reportId);
    },
  });
}

export const savePmReportToGarageTool = createSavePmReportToGarageTool();
export const listPmReportsFromGarageTool = createListPmReportsFromGarageTool();
export const viewPmReportFromGarageTool = createViewPmReportFromGarageTool();
