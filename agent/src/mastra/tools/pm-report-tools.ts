import {
  createLazyGarageObjectStorage,
  createPmReportStorage,
  getPmReport,
  listPmReports,
  savePmReport,
  type ObjectStorage,
  type PmReportMetadata,
} from '@chekku/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { formatStoredCreatedAt } from './markdown-table.js';

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

export function formatPmReportsMarkdown(reports: readonly PmReportListItem[]): string {
  if (reports.length === 0) return 'No saved reports found.';
  const rows = reports.map((report) =>
    `| [${report.reportId}](${report.reportUrl}) | ${formatStoredCreatedAt(report.createdAt)} | ${report.rating}/10 | ${report.status} |`,
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
  const nonBlankString = z.string().refine((value) => value.trim().length > 0, 'Value must not be blank.');
  return createTool({
    id: 'save_pm_report_to_garage',
    description: 'Save a PM Agent weekly report analysis to Garage object storage and return its metadata.',
    inputSchema: z.object({
      reportMarkdown: nonBlankString,
      analysisMarkdown: nonBlankString,
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
      reportId: z.string().regex(/^pmr_[0-9]{14}_[0-9a-f]{8}$/),
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
