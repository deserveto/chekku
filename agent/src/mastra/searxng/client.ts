import type { SearxngConfiguration } from './config.js';
import { searxngEndpoint } from './config.js';

export interface SearxngSearchInput {
  query: string;
  maxResults: number;
  page: number;
  language?: string;
  categories?: string[];
  engines?: string[];
  safeSearch?: 0 | 1 | 2;
  timeRange?: 'day' | 'month' | 'year';
}

export interface SearxngSearchResult {
  url: string;
  title: string;
  snippet: string;
  engines: string[];
  category?: string;
  score?: number;
  publishedAt?: string;
}

export interface SearxngSearchOutput {
  query: string;
  page: number;
  results: SearxngSearchResult[];
  answers: string[];
  corrections: string[];
  suggestions: string[];
  truncated: boolean;
}

export interface SearxngSearchClient {
  search(input: SearxngSearchInput, signal?: AbortSignal): Promise<SearxngSearchOutput>;
}

export interface SearxngSearchClientOptions {
  config: SearxngConfiguration | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 131_072;
const CAPABILITY_CACHE_MS = 5 * 60 * 1000;

const ERRORS = {
  unavailable: 'SearXNG search is unavailable. Try again later.',
  timeout: 'SearXNG search timed out. Try again.',
  format: 'The configured SearXNG instance does not provide JSON search.',
  tooLarge: 'SearXNG returned too much data.',
  invalid: 'SearXNG returned an invalid response.',
  targeting: 'Search targeting is not supported by the configured SearXNG instance.',
  input: 'SearXNG search input is invalid.',
} as const;

type ClientErrorCategory = keyof typeof ERRORS;

class SearxngClientError extends Error {
  constructor(readonly category: ClientErrorCategory) {
    super(ERRORS[category]);
  }
}

interface Capabilities {
  categories: Set<string>;
  engines: Set<string>;
  languages: Set<string>;
}

interface RequestDeadline {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  callerSignal?: AbortSignal;
}

function normalizeCapabilities(payload: unknown): Capabilities {
  if (typeof payload !== 'object' || payload === null) {
    throw new SearxngClientError('invalid');
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.categories)
    || !Array.isArray(record.engines)
    || typeof record.locales !== 'object'
    || record.locales === null
    || Array.isArray(record.locales)) {
    throw new SearxngClientError('invalid');
  }

  const categories = new Set(record.categories.filter(
    (value): value is string => typeof value === 'string',
  ));
  const engines = new Set<string>();
  const languages = new Set<string>(['all', 'auto']);
  for (const language of Object.keys(record.locales)) languages.add(language);
  for (const value of record.engines) {
    if (typeof value !== 'object' || value === null) continue;
    const engine = value as Record<string, unknown>;
    if (engine.enabled !== true || typeof engine.name !== 'string') continue;
    engines.add(engine.name);
    if (Array.isArray(engine.languages)) {
      for (const language of engine.languages) {
        if (typeof language === 'string') languages.add(language);
      }
    }
  }
  return { categories, engines, languages };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new SearxngClientError('format');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (!contentType || !/^application\/(?:json|[^/;+]+\+json)$/i.test(contentType)) {
    throw new SearxngClientError('format');
  }
  if (!response.body) throw new SearxngClientError('invalid');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new SearxngClientError('tooLarge');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new SearxngClientError('invalid');
  }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { value, truncated: false };

  let bytes = 0;
  let truncatedValue = '';
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    truncatedValue += character;
    bytes += characterBytes;
  }
  return { value: truncatedValue, truncated: true };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSearchPayload(
  payload: unknown,
  input: SearxngSearchInput,
): SearxngSearchOutput {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SearxngClientError('invalid');
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.results)) throw new SearxngClientError('invalid');

  let truncated = record.results.length > input.maxResults;
  const normalizedResults: SearxngSearchResult[] = [];
  for (const value of record.results) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      truncated = true;
      continue;
    }
    const result = value as Record<string, unknown>;
    if (typeof result.url !== 'string') {
      truncated = true;
      continue;
    }
    if (!isHttpUrl(result.url)) {
      truncated = true;
      continue;
    }

    const normalizedUrl = truncateUtf8(result.url, 2_048);
    if (!isHttpUrl(normalizedUrl.value)) {
      truncated = true;
      continue;
    }
    const normalizedTitle = truncateUtf8(
      typeof result.title === 'string' ? result.title : '',
      512,
    );
    const normalizedSnippet = truncateUtf8(
      typeof result.content === 'string' ? result.content : '',
      4_096,
    );
    truncated ||= typeof result.title !== 'string'
      || typeof result.content !== 'string'
      || normalizedUrl.truncated
      || normalizedTitle.truncated
      || normalizedSnippet.truncated;

    const engines: string[] = [];
    const seenEngines = new Set<string>();
    if (result.engines !== undefined && !Array.isArray(result.engines)) truncated = true;
    if (Array.isArray(result.engines)) {
      for (const engine of result.engines) {
        if (typeof engine !== 'string') {
          truncated = true;
          continue;
        }
        const normalizedEngine = truncateUtf8(engine, 128);
        truncated ||= normalizedEngine.truncated;
        if (seenEngines.has(normalizedEngine.value) || engines.length >= 8) {
          truncated = true;
          continue;
        }
        seenEngines.add(normalizedEngine.value);
        engines.push(normalizedEngine.value);
      }
    }

    const normalizedResult: SearxngSearchResult = {
      url: normalizedUrl.value,
      title: normalizedTitle.value,
      snippet: normalizedSnippet.value,
      engines,
    };
    if (result.category !== undefined) {
      if (typeof result.category === 'string') {
        const category = truncateUtf8(result.category, 128);
        normalizedResult.category = category.value;
        truncated ||= category.truncated;
      } else {
        truncated = true;
      }
    }
    if (result.score !== undefined) {
      if (typeof result.score === 'number' && Number.isFinite(result.score)) {
        normalizedResult.score = result.score;
      } else {
        truncated = true;
      }
    }
    if (result.publishedDate !== undefined) {
      if (typeof result.publishedDate === 'string') {
        const timestamp = Date.parse(result.publishedDate);
        if (Number.isFinite(timestamp)) {
          normalizedResult.publishedAt = new Date(timestamp).toISOString();
        } else {
          truncated = true;
        }
      } else {
        truncated = true;
      }
    }
    normalizedResults.push(normalizedResult);
  }

  const normalizeList = (key: string, maxItems: number, maxBytes: number): string[] => {
    const source = record[key];
    if (source === undefined) return [];
    if (!Array.isArray(source)) throw new SearxngClientError('invalid');
    const output: string[] = [];
    for (const value of source) {
      if (typeof value !== 'string' || output.length >= maxItems) {
        truncated = true;
        continue;
      }
      const normalized = truncateUtf8(value, maxBytes);
      output.push(normalized.value);
      truncated ||= normalized.truncated;
    }
    return output;
  };

  const output: SearxngSearchOutput = {
    query: input.query,
    page: input.page,
    results: normalizedResults.slice(0, input.maxResults),
    answers: normalizeList('answers', 5, 2_048),
    corrections: normalizeList('corrections', 10, 512),
    suggestions: normalizeList('suggestions', 10, 512),
    truncated,
  };
  const outputBytes = () => new TextEncoder().encode(JSON.stringify(output)).byteLength;
  if (outputBytes() > MAX_OUTPUT_BYTES) output.truncated = true;
  while (outputBytes() > MAX_OUTPUT_BYTES) {
    if (output.suggestions.length > 0) output.suggestions.pop();
    else if (output.corrections.length > 0) output.corrections.pop();
    else if (output.answers.length > 0) output.answers.pop();
    else if (output.results.length > 0) output.results.pop();
    else break;
  }
  return output;
}

export function createSearxngSearchClient(
  options: SearxngSearchClientOptions,
): SearxngSearchClient {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cachedCapabilities:
    | { value: Capabilities; expiresAt: number }
    | undefined;

  async function requestJson(
    config: SearxngConfiguration,
    path: 'config' | 'search',
    init: RequestInit,
    deadline: RequestDeadline,
  ): Promise<unknown> {
    try {
      const response = await fetch(searxngEndpoint(config, path), {
        ...init,
        redirect: 'error',
        signal: deadline.signal,
      });
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof SearxngClientError) throw error;
      if (!deadline.callerSignal?.aborted && deadline.timeoutSignal.aborted) {
        throw new SearxngClientError('timeout');
      }
      throw new SearxngClientError('unavailable');
    }
  }

  return {
    async search(input, signal) {
      const config = options.config;
      if (!config) {
        throw new Error('SearXNG search is not configured.');
      }
      if (!Number.isInteger(input.maxResults)
        || input.maxResults < 1
        || input.maxResults > 20
        || !Number.isInteger(input.page)
        || input.page < 1
        || input.page > 5) {
        throw new SearxngClientError('input');
      }
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 12_000);
      const deadline: RequestDeadline = {
        timeoutSignal,
        ...(signal ? { callerSignal: signal } : {}),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      };

      if (input.language !== undefined
        || input.categories !== undefined
        || input.engines !== undefined) {
        if (!cachedCapabilities || cachedCapabilities.expiresAt <= now()) {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
          const payload = await requestJson(config, 'config', {
            method: 'GET',
            headers,
          }, deadline);
          const value = normalizeCapabilities(payload);
          cachedCapabilities = { value, expiresAt: now() + CAPABILITY_CACHE_MS };
        }

        const capabilities = cachedCapabilities.value;
        const targetingSupported = (input.language === undefined
            || capabilities.languages.has(input.language))
          && (input.categories === undefined
            || input.categories.every((category) => capabilities.categories.has(category)))
          && (input.engines === undefined
            || input.engines.every((engine) => capabilities.engines.has(engine)));
        if (!targetingSupported) {
          throw new SearxngClientError('targeting');
        }
      }

      const body = new URLSearchParams();
      body.set('q', input.query);
      body.set('format', 'json');
      body.set('pageno', String(input.page));
      if (input.language !== undefined) body.set('language', input.language);
      if (input.categories !== undefined) body.set('categories', input.categories.join(','));
      if (input.engines !== undefined) body.set('engines', input.engines.join(','));
      if (input.timeRange !== undefined) body.set('time_range', input.timeRange);
      if (input.safeSearch !== undefined) body.set('safesearch', String(input.safeSearch));

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      const payload = await requestJson(config, 'search', {
        method: 'POST',
        headers,
        body,
      }, deadline);

      return normalizeSearchPayload(payload, input);
    },
  };
}
