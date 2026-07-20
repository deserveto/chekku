import { describe, expect, it, vi } from 'vitest';

import { createSearchWebTool } from './searxng-search.js';

describe('search_web tool', () => {
  it('exposes exact read-only open-world behavior without approval', () => {
    const tool = createSearchWebTool({ search: vi.fn() });
    expect(tool.id).toBe('search_web');
    expect(tool.requireApproval).toBeUndefined();
    expect(tool.mcp?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('applies defaults and forwards the caller abort signal', async () => {
    const search = vi.fn(async (input) => ({
      query: input.query, page: input.page, results: [], answers: [],
      corrections: [], suggestions: [], truncated: false,
    }));
    const tool = createSearchWebTool({ search });
    const abortSignal = new AbortController().signal;
    await tool.execute?.({ query: ' products ' }, { abortSignal } as never);
    expect(search).toHaveBeenCalledWith({
      query: 'products', maxResults: 10, page: 1,
    }, abortSignal);
  });

  it.each([
    { query: '' },
    { query: 'x'.repeat(1025) },
    { query: '雪'.repeat(342) },
    { query: 'x', maxResults: 21 },
    { query: 'x', page: 6 },
    { query: 'x', categories: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { query: 'x', categories: ['general', 'general'] },
    { query: 'x', engines: Array.from({ length: 11 }, (_, index) => `e${index}`) },
    { query: 'x', endpoint: 'https://evil.test' },
    { query: 'x', timeRange: 'week' },
  ])('rejects invalid strict input %#', (input) => {
    const tool = createSearchWebTool({ search: vi.fn() });
    expect(tool.inputSchema.safeParse(input).success).toBe(false);
  });
});
