import { describe, expect, it } from 'vitest';
import { buildAgentProxyUrl, buildRunsProxyUrl } from './proxy-url';

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

describe('buildRunsProxyUrl', () => {
  it('targets the run-start route for an empty path', () => {
    expect(buildRunsProxyUrl('http://localhost:4111/', [], '?a=1')).toBe(
      'http://localhost:4111/runs?a=1',
    );
  });

  it('joins run subpaths under /runs', () => {
    expect(
      buildRunsProxyUrl(
        'http://localhost:4111',
        ['run_20260101000000_00000001', 'events'],
        '?offset=0',
      ),
    ).toBe(
      'http://localhost:4111/runs/run_20260101000000_00000001/events?offset=0',
    );
  });

  it('rejects traversal and reserved URL characters', () => {
    expect(() => buildRunsProxyUrl('http://localhost:4111', ['..'], '')).toThrow('Unsafe');
    expect(() => buildRunsProxyUrl('http://localhost:4111', ['a/b'], '')).toThrow('Unsafe');
    expect(() => buildRunsProxyUrl('http://localhost:4111', ['a?b'], '')).toThrow('Unsafe');
  });
});
