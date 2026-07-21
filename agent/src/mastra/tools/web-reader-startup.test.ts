import { afterEach, describe, expect, it, vi } from 'vitest';

describe('read_web_page startup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['', 'bad\r\nkey'])(
    'keeps registry loadable with unusable key %#',
    async (apiKey) => {
      const fetch = vi.fn();
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv('WEB_READER_API_KEY', apiKey);
      vi.stubGlobal('fetch', fetch);
      vi.resetModules();

      const { readWebPageTool } = await import('./web-reader.js');

      expect(readWebPageTool.id).toBe('read_web_page');
      await expect(readWebPageTool.execute?.(
        { url: 'https://example.com/' },
        { abortSignal: new AbortController().signal } as never,
      )).rejects.toThrow('Web Reader is not configured.');
      expect(fetch).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});
