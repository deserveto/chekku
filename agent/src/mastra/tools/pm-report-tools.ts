import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { createLazyGarageReportStore } from '../pm-reports/garage-store.js';
import { getPmReport, listPmReports, savePmReport, type PmReportObjectStore } from '../pm-reports/store.js';

const statusSchema = z.enum(['ON-TRACK', 'WARNING', 'IN-DANGER']);

const metadataSchema = z.object({
  reportId: z.string(),
  createdAt: z.string(),
  rating: z.number(),
  status: statusSchema,
  inputObjectKey: z.string(),
  analysisObjectKey: z.string(),
  metadataObjectKey: z.string(),
});

export interface PmReportToolOptions {
  storeFactory?: () => PmReportObjectStore;
  now?: () => Date;
}

export function createSavePmReportToGarageTool(options: PmReportToolOptions = {}) {
  const storeFactory = options.storeFactory ?? createLazyGarageReportStore;
  return createTool({
    id: 'save_pm_report_to_garage',
    description: 'Save a PM Agent weekly report analysis to Garage object storage and return the report id and object keys.',
    inputSchema: z.object({
      reportMarkdown: z.string().trim().min(1),
      analysisMarkdown: z.string().trim().min(1),
      reportId: z.string().regex(/^pmr_[a-zA-Z0-9_-]+$/).optional(),
    }),
    outputSchema: metadataSchema,
    execute: async (input) => {
      const store = storeFactory();
      await store.ensureReady?.();
      return savePmReport({
        store,
        reportMarkdown: input.reportMarkdown,
        analysisMarkdown: input.analysisMarkdown,
        ...(input.reportId ? { reportId: input.reportId } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    },
  });
}

export function createListPmReportsFromGarageTool(options: PmReportToolOptions = {}) {
  const storeFactory = options.storeFactory ?? createLazyGarageReportStore;
  return createTool({
    id: 'list_pm_reports_from_garage',
    description: 'List PM Agent reports saved in Garage, newest first.',
    inputSchema: z.object({}),
    outputSchema: z.object({ reports: z.array(metadataSchema) }),
    execute: async () => {
      const store = storeFactory();
      await store.ensureReady?.();
      return { reports: await listPmReports(store) };
    },
  });
}

export function createViewPmReportFromGarageTool(options: PmReportToolOptions = {}) {
  const storeFactory = options.storeFactory ?? createLazyGarageReportStore;
  return createTool({
    id: 'view_pm_report_from_garage',
    description: 'View a saved PM Agent report from Garage by report id.',
    inputSchema: z.object({ reportId: z.string().regex(/^pmr_[a-zA-Z0-9_-]+$/) }),
    outputSchema: z.object({
      reportId: z.string(),
      inputMarkdown: z.string(),
      analysisMarkdown: z.string(),
      metadata: metadataSchema,
    }),
    execute: async ({ reportId }) => {
      const store = storeFactory();
      await store.ensureReady?.();
      return getPmReport(store, reportId);
    },
  });
}

export const savePmReportToGarageTool = createSavePmReportToGarageTool();
export const listPmReportsFromGarageTool = createListPmReportsFromGarageTool();
export const viewPmReportFromGarageTool = createViewPmReportFromGarageTool();
