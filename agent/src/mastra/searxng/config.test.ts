import { describe, expect, it } from 'vitest';

import {
  parseSearxngConfiguration,
  searxngEndpoint,
} from './config.js';

describe('SearXNG configuration', () => {
  it('treats an empty endpoint as unconfigured', () => {
    expect(parseSearxngConfiguration({ baseUrl: '', apiKey: '' })).toBeUndefined();
  });

  it('preserves a deployment path and constructs fixed endpoints', () => {
    const config = parseSearxngConfiguration({
      baseUrl: 'https://search.example.test/private',
      apiKey: 'token',
    })!;
    expect(searxngEndpoint(config, 'config').href)
      .toBe('https://search.example.test/private/config');
    expect(searxngEndpoint(config, 'search').href)
      .toBe('https://search.example.test/private/search');
    expect(config.apiKey).toBe('token');
  });

  it.each([
    'ftp://search.example.test',
    'https://user:pass@search.example.test',
    'https://search.example.test?q=secret',
    'https://search.example.test/#fragment',
  ])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => parseSearxngConfiguration({ baseUrl, apiKey: '' }))
      .toThrow('SearXNG search configuration is invalid.');
  });

  it('rejects bearer values containing line breaks without echoing the value', () => {
    const secret = 'private\r\nInjected: yes';
    expect(() => parseSearxngConfiguration({
      baseUrl: 'https://search.example.test',
      apiKey: secret,
    })).toThrow('SearXNG search configuration is invalid.');
    try {
      parseSearxngConfiguration({ baseUrl: 'https://search.example.test', apiKey: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
