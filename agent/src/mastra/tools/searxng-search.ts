import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { env } from '../../config/env.js';
import {
  createSearxngSearchClient,
  type SearxngSearchClient,
} from '../searxng/client.js';
import { parseSearxngConfiguration } from '../searxng/config.js';

const querySchema = z.string().refine(
  (query) => query.trim().length > 0 && Buffer.byteLength(query.trim(), 'utf8') <= 1_024,
  'Query must be non-empty and at most 1,024 UTF-8 bytes.',
);

function uniqueStringList(maxItems: number) {
  return z.array(z.string().min(1)).max(maxItems).refine(
    (values) => new Set(values).size === values.length,
    'Values must be unique.',
  );
}

const inputSchema = z.object({
  query: querySchema,
  maxResults: z.number().int().min(1).max(20).optional(),
  page: z.number().int().min(1).max(5).optional(),
  language: z.string().min(1).optional(),
  categories: uniqueStringList(5).optional(),
  engines: uniqueStringList(10).optional(),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  timeRange: z.enum(['day', 'month', 'year']).optional(),
}).strict();

const outputSchema = z.object({
  query: z.string(),
  page: z.number().int(),
  results: z.array(z.object({
    url: z.string(),
    title: z.string(),
    snippet: z.string(),
    engines: z.array(z.string()),
    category: z.string().optional(),
    score: z.number().finite().optional(),
    publishedAt: z.string().optional(),
  }).strict()),
  answers: z.array(z.string()),
  corrections: z.array(z.string()),
  suggestions: z.array(z.string()),
  truncated: z.boolean(),
}).strict();

function createDefaultSearchClient(): SearxngSearchClient {
  let client: SearxngSearchClient | undefined;
  const getClient = (): SearxngSearchClient => {
    client ??= createSearxngSearchClient({
      config: parseSearxngConfiguration({
        baseUrl: env.SEARXNG_BASE_URL,
        apiKey: env.SEARXNG_API_KEY,
      }),
    });
    return client;
  };

  return {
    search: (input, signal) => getClient().search(input, signal),
  };
}

export function createSearchWebTool(
  client: SearxngSearchClient = createDefaultSearchClient(),
) {
  const tool = createTool({
    id: 'search_web',
    description: 'Search the web through the server-owned SearXNG instance and return bounded result metadata and snippets.',
    inputSchema,
    outputSchema,
    mcp: { annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    } },
    execute: async (input, context) => client.search({
      ...input,
      query: input.query.trim(),
      maxResults: input.maxResults ?? 10,
      page: input.page ?? 1,
    }, context.abortSignal),
  });
  tool.requireApproval = undefined;
  return tool as typeof tool & {
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
  };
}

export const searchWebTool = createSearchWebTool();
