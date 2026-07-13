import { describe, expect, it } from 'vitest';
import { buildAgentProxyUrl } from './proxy-url';

describe('buildAgentProxyUrl', () => {
  it('maps adapter paths to the Mastra api namespace', () => {
    expect(buildAgentProxyUrl(
      'http://localhost:4111/',
      ['agents', 'demo-agent', 'stream'],
      '?x=1',
    )).toBe('http://localhost:4111/api/agents/demo-agent/stream?x=1');
  });

  it('does not duplicate the api segment used by @mastra/client-js', () => {
    expect(buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'stored', 'agents'],
      '',
    )).toBe('http://localhost:4111/api/stored/agents');
  });
  it('preserves explicitly allowed root-level custom routes', () => {
  expect(
    buildAgentProxyUrl(
      'http://localhost:4111',
      ['models'],
      '',
    ),
  ).toBe('http://localhost:4111/models');

  expect(
    buildAgentProxyUrl(
      'http://localhost:4111',
      ['healthz'],
      '',
    ),
  ).toBe('http://localhost:4111/healthz');
  });
  it('rejects traversal and reserved URL characters', () => {
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['..'], '')).toThrow('Unsafe');
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['a/b'], '')).toThrow('Unsafe');
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['a?b'], '')).toThrow('Unsafe');
  });
});
