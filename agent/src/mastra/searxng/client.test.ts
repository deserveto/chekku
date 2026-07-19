import { describe, expect, it, vi } from 'vitest';

import { parseSearxngConfiguration } from './config.js';
import { createSearxngSearchClient } from './client.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json' }, ...init },
);

const config = parseSearxngConfiguration({
  baseUrl: 'https://search.example.test/private/',
  apiKey: 'private-token',
})!;

describe('SearXNG search client', () => {
  it('posts only fixed search form fields with server-owned authentication', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => (
      jsonResponse({ results: [] })
    ));
    const client = createSearxngSearchClient({ config, fetch });

    await client.search({
      query: 'competitor research',
      maxResults: 10,
      page: 2,
      safeSearch: 1,
      timeRange: 'month',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://search.example.test/private/search');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer private-token',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    expect(String(init?.body)).toBe(
      'q=competitor+research&format=json&pageno=2&time_range=month&safesearch=1',
    );
  });

  it('fails closed when no endpoint is configured', async () => {
    const client = createSearxngSearchClient({ config: undefined, fetch: vi.fn() });
    await expect(client.search({ query: 'x', maxResults: 10, page: 1 }))
      .rejects.toThrow('SearXNG search is not configured.');
  });

  it('validates and caches optional targeting from fixed config', async () => {
    let now = 1_000;
    const fetch = vi.fn(async (url: URL | RequestInfo) => String(url).endsWith('/config')
      ? jsonResponse({
          categories: ['general', 'news'],
          locales: { en: 'English' },
          engines: [
            { name: 'brave', enabled: true, languages: ['en'] },
            { name: 'disabled', enabled: false, languages: ['en'] },
          ],
        })
      : jsonResponse({ results: [] }));
    const client = createSearxngSearchClient({ config, fetch, now: () => now });
    const input = {
      query: 'x', maxResults: 10, page: 1,
      language: 'en', categories: ['general'], engines: ['brave'],
    };

    await client.search(input);
    now += 299_999;
    await client.search(input);

    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/config'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/search'))).toHaveLength(2);
  });

  it.each([
    [{ language: 'xx' }, 'language'],
    [{ categories: ['unknown'] }, 'categories'],
    [{ engines: ['disabled'] }, 'engines'],
  ])('rejects unsupported targeting %j before search', async (targeting, _field) => {
    const fetch = vi.fn(async () => jsonResponse({
      categories: ['general'],
      locales: { en: 'English' },
      engines: [{ name: 'brave', enabled: true, languages: ['en'] }],
    }));
    const client = createSearxngSearchClient({ config, fetch });
    await expect(client.search({
      query: 'x', maxResults: 10, page: 1, ...targeting,
    })).rejects.toThrow('Search targeting is not supported by the configured SearXNG instance.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [new Response('forbidden-private-body', { status: 403 }),
      'The configured SearXNG instance does not provide JSON search.'],
    [new Response('<html>private</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }), 'The configured SearXNG instance does not provide JSON search.'],
    [new Response('{bad', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'SearXNG returned an invalid response.'],
  ])('maps unsafe upstream response to fixed error', async (response, message) => {
    const fetch = vi.fn(async () => response);
    const client = createSearxngSearchClient({ config, fetch });
    const error = await client.search({ query: 'x', maxResults: 10, page: 1 })
      .then(() => undefined, (reason: unknown) => reason);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toMatch(/private-token|search\.example|private-body|<html>/);
  });

  it('maps fetch and redirect rejection without exposing diagnostics', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('redirect to https://search.example/private-token');
    });
    const client = createSearxngSearchClient({ config, fetch });
    const error = await client.search({ query: 'private-body', maxResults: 10, page: 1 })
      .then(() => undefined, (reason: unknown) => reason);

    expect(String(error)).toContain('SearXNG search is unavailable. Try again later.');
    expect(String(error)).not.toMatch(/private-token|search\.example|private-body/);
  });

  it('maps the client-owned deadline to a fixed timeout error', async () => {
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason),
        { once: true },
      ),
    ));
    const client = createSearxngSearchClient({ config, fetch, timeoutMs: 1 });

    await expect(client.search({ query: 'x', maxResults: 10, page: 1 }))
      .rejects.toThrow('SearXNG search timed out. Try again.');
  });

  it('maps caller cancellation without exposing the abort reason', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      throw init?.signal?.reason;
    });
    const controller = new AbortController();
    controller.abort('private-caller-reason');
    const client = createSearxngSearchClient({ config, fetch });
    const error = await client.search(
      { query: 'x', maxResults: 10, page: 1 },
      controller.signal,
    ).then(() => undefined, (reason: unknown) => reason);

    expect(String(error)).toContain('SearXNG search is unavailable. Try again later.');
    expect(String(error)).not.toContain('private-caller-reason');
  });

  it('stops reading a streamed response above 2 MiB', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    }));
    const client = createSearxngSearchClient({ config, fetch });

    await expect(client.search({ query: 'x', maxResults: 10, page: 1 }))
      .rejects.toThrow('SearXNG returned too much data.');
    expect(cancelled).toBe(true);
  });

  it('normalizes untrusted results within field, list, and output byte limits', async () => {
    const largeResult = (index: number) => ({
      url: `https://result.example/${index}/${'u'.repeat(3_000)}`,
      title: `Title ${index} ${'😀'.repeat(300)}`,
      content: `Snippet ${index} ${'😀'.repeat(1_500)}`,
      engines: [
        ...Array.from({ length: 9 }, (_, engine) => `engine-${engine}-${'e'.repeat(150)}`),
        'engine-0',
      ],
      category: 'c'.repeat(200),
      score: Number.POSITIVE_INFINITY,
      publishedDate: 'not-a-date',
      diagnostic: 'private-upstream-diagnostic',
    });
    const results = [
      {
        url: 'https://product.example/',
        title: 'Product',
        content: 'Useful summary',
        engines: ['brave'],
        category: 'general',
        score: 3.5,
        publishedDate: '2026-07-19',
      },
      { url: 'file:///private-file', title: 'Private file', content: 'omit me' },
      ...Array.from({ length: 19 }, (_, index) => largeResult(index)),
    ];
    const fetch = vi.fn(async () => jsonResponse({
      results,
      answers: Array.from({ length: 6 }, (_, index) => `answer-${index}-${'😀'.repeat(600)}`),
      corrections: Array.from({ length: 11 }, (_, index) => `correction-${index}-${'😀'.repeat(200)}`),
      suggestions: Array.from({ length: 11 }, (_, index) => `suggestion-${index}-${'😀'.repeat(200)}`),
      unresponsive_engines: [['private-engine', 'private-diagnostic']],
    }));
    const client = createSearxngSearchClient({ config, fetch });

    const output = await client.search({ query: 'products', maxResults: 20, page: 1 });

    expect(output.results[0]).toEqual({
      url: 'https://product.example/',
      title: 'Product',
      snippet: 'Useful summary',
      engines: ['brave'],
      category: 'general',
      score: 3.5,
      publishedAt: '2026-07-19T00:00:00.000Z',
    });
    expect(output.results.some((item) => item.url.startsWith('file:'))).toBe(false);
    expect(output.results.every((item) => Buffer.byteLength(item.url, 'utf8') <= 2_048))
      .toBe(true);
    expect(output.results.every((item) => Buffer.byteLength(item.title, 'utf8') <= 512))
      .toBe(true);
    expect(output.results.every((item) => Buffer.byteLength(item.snippet, 'utf8') <= 4_096))
      .toBe(true);
    expect(output.results.every((item) => item.engines.length <= 8
      && new Set(item.engines).size === item.engines.length
      && item.engines.every((engine) => Buffer.byteLength(engine, 'utf8') <= 128)))
      .toBe(true);
    expect(output.answers.length).toBeLessThanOrEqual(5);
    expect(output.corrections.length).toBeLessThanOrEqual(10);
    expect(output.suggestions.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(131_072);
    expect(JSON.stringify(output)).not.toContain('private-upstream-diagnostic');
    expect(output.truncated).toBe(true);
  });

  it('returns a small clean response without truncation', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      results: [{
        url: 'https://example.test/path',
        title: 'Example',
        content: 'Summary',
        engines: ['brave'],
      }],
      answers: ['Answer'],
      corrections: ['Correction'],
      suggestions: ['Suggestion'],
    }));
    const client = createSearxngSearchClient({ config, fetch });

    await expect(client.search({ query: 'example', maxResults: 10, page: 3 }))
      .resolves.toEqual({
        query: 'example',
        page: 3,
        results: [{
          url: 'https://example.test/path',
          title: 'Example',
          snippet: 'Summary',
          engines: ['brave'],
        }],
        answers: ['Answer'],
        corrections: ['Correction'],
        suggestions: ['Suggestion'],
        truncated: false,
      });
  });
});
