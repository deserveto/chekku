import {
  createCompetitiveAnalysisStorage,
  createLazyGarageObjectStorage,
  getCompetitiveAnalysis,
  listCompetitiveAnalyses,
  saveCompetitiveAnalysis,
  type CompetitiveAnalysisMetadata,
  type ObjectStorage,
} from '@chekku/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { parsePublicWebUrl } from '../web-reader/url.js';
import { escapeMarkdownTableCell, formatStoredCreatedAt } from './markdown-table.js';

const MAX_MARKDOWN_BYTES = 262_144;
const MAX_NAME_BYTES = 256;
const MAX_MARKET_BYTES = 512;

const boundedTrimmedString = (maxBytes: number) => z.string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'Value must not be blank.')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, `Value exceeds ${maxBytes} UTF-8 bytes.`);

const markdownSchema = z.string()
  .refine((value) => value.trim().length > 0, 'Value must not be blank.')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_MARKDOWN_BYTES,
    `Value exceeds ${MAX_MARKDOWN_BYTES} UTF-8 bytes.`,
  );

const nameSchema = boundedTrimmedString(MAX_NAME_BYTES);
const publicUrlSchema = z.string().transform((value, context) => {
  try {
    return parsePublicWebUrl(value).href;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Source URL must be a public HTTP(S) URL.' });
    return z.NEVER;
  }
});

const sourceSchema = z.object({
  productName: nameSchema,
  url: publicUrlSchema,
}).strict();

const saveInputSchema = z.object({
  requestMarkdown: markdownSchema,
  analysisMarkdown: markdownSchema,
  anchorProduct: nameSchema,
  market: boundedTrimmedString(MAX_MARKET_BYTES).optional(),
  competitorNames: z.array(nameSchema).min(5).max(7),
  sources: z.array(sourceSchema).min(6).max(8),
}).strict().superRefine((input, context) => {
  const products = [input.anchorProduct, ...input.competitorNames];
  const productKeys = products.map((name) => name.toLowerCase());
  if (new Set(productKeys).size !== productKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['competitorNames'],
      message: 'Anchor and competitor names must be unique case-insensitively.',
    });
  }

  const sourceProductKeys = input.sources.map(({ productName }) => productName.toLowerCase());
  if (new Set(sourceProductKeys).size !== sourceProductKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'Each product must have exactly one source mapping.',
    });
  }
  const expectedProducts = new Set(productKeys);
  const actualProducts = new Set(sourceProductKeys);
  if (expectedProducts.size !== actualProducts.size
    || [...expectedProducts].some((product) => !actualProducts.has(product))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'Sources must exactly cover the anchor and every competitor.',
    });
  }

  const urls = input.sources.map(({ url }) => url);
  if (new Set(urls).size !== urls.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'Source URLs must be unique after normalization.',
    });
  }
});

const metadataSchema = z.object({
  analysisId: z.string().regex(/^pca_[0-9]{14}_[0-9a-f]{8}$/),
  createdAt: z.string(),
  anchorProduct: z.string(),
  market: z.string().optional(),
  competitorNames: z.array(z.string()).min(5).max(7),
  productCount: z.number().int().min(6).max(8),
  sourceCount: z.number().int().min(6).max(8),
  requestObjectKey: z.string(),
  analysisObjectKey: z.string(),
  metadataObjectKey: z.string(),
}).strict();

const listMetadataSchema = metadataSchema.extend({
  analysisUrl: z.string(),
}).strict();

export interface CompetitiveAnalysisToolOptions {
  storeFactory?: () => ObjectStorage;
  now?: () => Date;
}

type CompetitiveAnalysisListItem = CompetitiveAnalysisMetadata & { analysisUrl: string };

function competitiveAnalysisStore(options: CompetitiveAnalysisToolOptions): ObjectStorage {
  return createCompetitiveAnalysisStorage(
    (options.storeFactory ?? createLazyGarageObjectStorage)(),
  );
}

export function formatCompetitiveAnalysesMarkdown(
  analyses: readonly CompetitiveAnalysisListItem[],
): string {
  if (analyses.length === 0) return 'No saved competitive analyses found.';
  const rows = analyses.map((analysis) =>
    `| [${analysis.analysisId}](${analysis.analysisUrl}) | ${formatStoredCreatedAt(analysis.createdAt)} | ${escapeMarkdownTableCell(analysis.anchorProduct)} | ${analysis.competitorNames.length} | ${analysis.sourceCount} |`);
  return [
    '| Analysis | Created | Anchor | Competitors | Sources |',
    '| --- | --- | --- | ---: | ---: |',
    ...rows,
  ].join('\n');
}

export function createSaveCompetitiveAnalysisToGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
) {
  return createTool({
    id: 'save_competitive_analysis_to_garage',
    description: 'Save a complete PM competitive analysis to Garage object storage and return its metadata.',
    inputSchema: saveInputSchema,
    outputSchema: metadataSchema,
    execute: async (rawInput) => {
      const input = saveInputSchema.parse(rawInput);
      const store = competitiveAnalysisStore(options);
      await store.ensureReady?.();
      return saveCompetitiveAnalysis({
        store,
        requestMarkdown: input.requestMarkdown,
        analysisMarkdown: input.analysisMarkdown,
        anchorProduct: input.anchorProduct,
        ...(input.market === undefined ? {} : { market: input.market }),
        competitorNames: input.competitorNames,
        sourceCount: input.sources.length,
        ...(options.now ? { now: options.now } : {}),
      });
    },
  });
}

export function createListCompetitiveAnalysesFromGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
) {
  return createTool({
    id: 'list_competitive_analyses_from_garage',
    description: 'List PM competitive analyses saved in Garage, newest first.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      analyses: z.array(listMetadataSchema),
      analysesMarkdown: z.string(),
    }).strict(),
    execute: async () => {
      const store = competitiveAnalysisStore(options);
      await store.ensureReady?.();
      const analyses = (await listCompetitiveAnalyses(store)).map((analysis) => ({
        ...analysis,
        analysisUrl: `/reports/competitive/${encodeURIComponent(analysis.analysisId)}`,
      }));
      return { analyses, analysesMarkdown: formatCompetitiveAnalysesMarkdown(analyses) };
    },
  });
}

export function createViewCompetitiveAnalysisFromGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
) {
  return createTool({
    id: 'view_competitive_analysis_from_garage',
    description: 'View a saved PM competitive analysis from Garage by analysis id.',
    inputSchema: z.object({
      analysisId: z.string().regex(/^pca_[0-9]{14}_[0-9a-f]{8}$/),
    }).strict(),
    outputSchema: z.object({
      analysisId: z.string(),
      requestMarkdown: z.string(),
      analysisMarkdown: z.string(),
      metadata: metadataSchema,
    }).strict(),
    execute: async ({ analysisId }) => {
      const store = competitiveAnalysisStore(options);
      await store.ensureReady?.();
      return getCompetitiveAnalysis(store, analysisId);
    },
  });
}

export const saveCompetitiveAnalysisToGarageTool = createSaveCompetitiveAnalysisToGarageTool();
export const listCompetitiveAnalysesFromGarageTool = createListCompetitiveAnalysesFromGarageTool();
export const viewCompetitiveAnalysisFromGarageTool = createViewCompetitiveAnalysisFromGarageTool();
