import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { defaultPmReportsDir, getPmReport, listPmReports, savePmReport } from '../pm-reports/store.js';

const statusSchema = z.enum(['ON-TRACK', 'WARNING', 'IN-DANGER']);

const metadataSchema = z.object({
  reportId: z.string(),
  createdAt: z.string(),
  rating: z.number(),
  status: statusSchema,
  inputPath: z.string(),
  analysisPath: z.string(),
  metadataPath: z.string(),
});

export interface PmReportToolOptions {
  baseDir?: string;
  now?: () => Date;
}

export function createSavePmReportTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'save_pm_report',
    description: 'Save a PM Agent weekly report analysis to local Chekku report storage.',
    inputSchema: z.object({
      reportMarkdown: z.string().trim().min(1),
      analysisMarkdown: z.string().trim().min(1),
      reportId: z.string().regex(/^pmr_[a-zA-Z0-9_-]+$/).optional(),
    }),
    outputSchema: metadataSchema,
    execute: async (input) => savePmReport({
      baseDir: options.baseDir ?? defaultPmReportsDir,
      reportMarkdown: input.reportMarkdown,
      analysisMarkdown: input.analysisMarkdown,
      ...(input.reportId ? { reportId: input.reportId } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  });
}

export function createListPmReportsTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'list_pm_reports',
    description: 'List PM Agent weekly reports saved in local Chekku report storage, newest first.',
    inputSchema: z.object({}),
    outputSchema: z.object({ reports: z.array(metadataSchema) }),
    execute: async () => ({ reports: await listPmReports(options.baseDir ?? defaultPmReportsDir) }),
  });
}

export function createViewPmReportTool(options: PmReportToolOptions = {}) {
  return createTool({
    id: 'view_pm_report',
    description: 'View a saved PM Agent weekly report from local Chekku report storage by report id.',
    inputSchema: z.object({ reportId: z.string().regex(/^pmr_[a-zA-Z0-9_-]+$/) }),
    outputSchema: z.object({
      reportId: z.string(),
      inputMarkdown: z.string(),
      analysisMarkdown: z.string(),
      metadata: metadataSchema,
    }),
    execute: async ({ reportId }) => getPmReport(options.baseDir ?? defaultPmReportsDir, reportId),
  });
}

export const savePmReportTool = createSavePmReportTool();
export const listPmReportsTool = createListPmReportsTool();
export const viewPmReportTool = createViewPmReportTool();
