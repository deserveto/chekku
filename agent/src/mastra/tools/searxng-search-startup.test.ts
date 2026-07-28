import { afterEach, describe, expect, it, vi } from 'vitest';

describe('search_web startup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    'not-a-url',
    'https://user:token@searxng.internal',
  ])('defers invalid optional configuration until search execution: %s', async (baseUrl) => {
    vi.stubEnv('SEARXNG_BASE_URL', baseUrl);
    vi.stubEnv('SEARXNG_API_KEY', '');
    vi.resetModules();

    const { searchWebTool } = await import('./searxng-search.js');

    expect(searchWebTool.id).toBe('search_web');
    await expect(searchWebTool.execute?.(
      { query: 'products' },
      { abortSignal: new AbortController().signal } as never,
    )).rejects.toThrow('SearXNG search configuration is invalid.');
  });
});
