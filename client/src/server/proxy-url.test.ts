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

  it('blocks the native workflow HTTP API from the browser proxy', () => {
    // Wrapping an agent with `createDurableAgent` auto-registers the
    // general-purpose `durable-agentic-loop` engine workflow, and the agent
    // server runs without an auth provider — proxying this namespace would
    // let any signed-in user drive any agent outside the guarded `/runs`
    // surface. App workflows are triggered server-side over AGENT_URL
    // directly, so nothing legitimate goes through the proxy.
    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'workflows', 'durable-agentic-loop', 'create-run'],
      '',
    )).toThrow('Workflow API is not available through the agent proxy');

    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'workflows', 'weekly-social-drafts', 'start'],
      '',
    )).toThrow('Workflow API is not available through the agent proxy');

    // Adapter-style paths (no leading api segment) normalize into the api
    // namespace first, so the block applies to them too.
    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['workflows', 'durable-agentic-loop', 'create-run'],
      '',
    )).toThrow('Workflow API is not available through the agent proxy');
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
