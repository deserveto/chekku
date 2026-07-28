import { describe, expect, it, vi } from 'vitest';

import { createReadWebPageTool } from './web-reader.js';

describe('read_web_page tool', () => {
  it('exposes exact read-only open-world behavior without approval', () => {
    const tool = createReadWebPageTool({ read: vi.fn() });
    expect(tool.id).toBe('read_web_page');
    expect(tool.requireApproval).toBeUndefined();
    expect(tool.mcp?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('forwards one URL and caller abort signal', async () => {
    const output = {
      requestedUrl: 'https://example.com/', sourceUrl: 'https://example.com/',
      title: 'Example', markdown: 'content', contentIsUntrusted: true as const,
      truncated: false,
    };
    const read = vi.fn(async () => output);
    const tool = createReadWebPageTool({ read });
    const abortSignal = new AbortController().signal;

    await expect(tool.execute?.(
      { url: 'https://example.com/' },
      { abortSignal } as never,
    )).resolves.toEqual(output);
    expect(read).toHaveBeenCalledWith('https://example.com/', abortSignal);
  });

  it.each([
    {},
    { url: '' },
    { url: 'ftp://example.com/' },
    { url: 'http://127.0.0.1/' },
    { url: 'https://example.com/', endpoint: 'https://evil.test' },
    { url: 'https://example.com/', headers: { Authorization: 'secret' } },
    { url: 'https://example.com/', cookie: 'session=secret' },
    { url: 'https://example.com/', proxy: 'http://evil.test' },
    { url: 'https://example.com/', timeout: 180 },
  ])('rejects invalid strict input %#', (input) => {
    const tool = createReadWebPageTool({ read: vi.fn() });
    expect(tool.inputSchema.safeParse(input).success).toBe(false);
  });
});
