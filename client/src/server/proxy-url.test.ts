import { describe, expect, it } from 'vitest';
import { buildAgentProxyUrl, buildRunsProxyUrl } from './proxy-url';

describe('buildAgentProxyUrl', () => {
  it('maps adapter paths to the Mastra api namespace', () => {
    expect(buildAgentProxyUrl(
      'http://localhost:4111/',
      ['agents'],
      '?x=1',
      'GET',
    )).toBe('http://localhost:4111/api/agents?x=1');
  });

  it('does not duplicate the api segment used by @mastra/client-js', () => {
    expect(buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'stored', 'agents'],
      '',
      'GET',
    )).toBe('http://localhost:4111/api/stored/agents');
  });
  it('preserves explicitly allowed root-level custom routes', () => {
    expect(
      buildAgentProxyUrl(
        'http://localhost:4111',
        ['models'],
        '',
        'GET',
      ),
    ).toBe('http://localhost:4111/models');

    expect(
      buildAgentProxyUrl(
        'http://localhost:4111',
        ['healthz'],
        '',
        'HEAD',
      ),
    ).toBe('http://localhost:4111/healthz');
  });
  it('rejects traversal and reserved URL characters', () => {
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['..'], '', 'GET')).toThrow('Unsafe');
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['a/b'], '', 'GET')).toThrow('Unsafe');
    expect(() => buildAgentProxyUrl('http://localhost:4111', ['a?b'], '', 'GET')).toThrow('Unsafe');
  });

  it('serves every browser-consumed native route on the allowlist', () => {
    const allowed: ReadonlyArray<
      readonly [string, readonly string[], string]
    > = [
      ['GET', ['api', 'agents'], 'catalog list'],
      ['GET', ['api', 'agents', 'main-agent'], 'agent details / skills'],
      ['GET', ['api', 'stored', 'agents'], 'stored catalog list'],
      ['POST', ['api', 'stored', 'agents'], 'stored create'],
      ['GET', ['api', 'stored', 'agents', 'demo'], 'stored details'],
      ['PATCH', ['api', 'stored', 'agents', 'demo'], 'stored update'],
      ['PUT', ['api', 'stored', 'agents', 'demo'], 'stored update (PUT)'],
      ['DELETE', ['api', 'stored', 'agents', 'demo'], 'stored delete'],
      ['GET', ['api', 'memory', 'threads'], 'thread list'],
      ['GET', ['api', 'memory', 'threads', 't-1'], 'thread read'],
      ['PATCH', ['api', 'memory', 'threads', 't-1'], 'thread rename'],
      ['DELETE', ['api', 'memory', 'threads', 't-1'], 'thread delete'],
      ['GET', ['api', 'memory', 'threads', 't-1', 'messages'], 'thread messages'],
    ];
    for (const [method, path] of allowed) {
      expect(() =>
        buildAgentProxyUrl('http://localhost:4111', path, '', method),
      ).not.toThrow();
    }
  });

  it('blocks the native workflow HTTP API from the browser proxy', () => {
    // Registering a durable agent auto-registers the general-purpose
    // `durable-agentic-loop` engine workflow, and the agent
    // server runs without an auth provider — proxying this namespace would
    // let any signed-in user drive any agent outside the guarded `/runs`
    // surface. App workflows are triggered server-side over AGENT_URL
    // directly, so nothing legitimate goes through the proxy.
    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'workflows', 'durable-agentic-loop', 'create-run'],
      '',
      'POST',
    )).toThrow('Workflow API is not available through the agent proxy');

    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['api', 'workflows', 'weekly-social-drafts', 'start'],
      '',
      'POST',
    )).toThrow('Workflow API is not available through the agent proxy');

    // Adapter-style paths (no leading api segment) normalize into the api
    // namespace first, so the block applies to them too.
    expect(() => buildAgentProxyUrl(
      'http://localhost:4111',
      ['workflows', 'durable-agentic-loop', 'create-run'],
      '',
      'POST',
    )).toThrow('Workflow API is not available through the agent proxy');
  });

  it('blocks every other caller-drivable native agent route', () => {
    // The agent server has no auth provider; proxying any run-driving
    // route would bypass the guarded `/runs` surface (no 409 lock, 429
    // caps, watchdog, prompt bounds, or thread-ownership collapse).
    const blocked: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['POST', ['api', 'agents', 'main-agent', 'generate']],
      ['POST', ['api', 'agents', 'main-agent', 'send-message']],
      ['POST', ['api', 'agents', 'main-agent', 'queue-message']],
      ['POST', ['api', 'agents', 'main-agent', 'threads', 't-1', 'abort']],
      ['POST', ['api', 'agents', 'main-agent', 'threads', 't-1', 'clone']],
      ['GET', ['api', 'agents', 'main-agent', 'threads', 'subscribe']],
      ['POST', ['agents', 'pm-agent', 'generate']],
      ['POST', ['api', 'memory', 'threads', 't-1', 'clone']],
      ['POST', ['api', 'stored', 'agents', 'demo', 'versions']],
      ['POST', ['api', 'stored', 'agents', 'demo', 'versions', 'v1', 'activate']],
      ['GET', ['api', 'stored', 'agents', 'demo', 'export']],
      ['GET', ['api', 'tools']],
      ['GET', ['api', 'tracing']],
      // Unknown future native namespaces fall through to the same block.
      ['POST', ['api', 'networks', 'supervisor', 'generate']],
    ];
    for (const [method, path] of blocked) {
      expect(() =>
        buildAgentProxyUrl('http://localhost:4111', path, '', method),
      ).toThrow('This agent API route is not available through the agent proxy');
    }
  });

  it('rejects disallowed methods on otherwise allowed shapes', () => {
    expect(() =>
      buildAgentProxyUrl('http://localhost:4111', ['api', 'agents'], '', 'POST'),
    ).toThrow('not available through the agent proxy');
    expect(() =>
      buildAgentProxyUrl('http://localhost:4111', ['api', 'memory', 'threads', 't-1', 'messages'], '', 'DELETE'),
    ).toThrow('not available through the agent proxy');
    expect(() =>
      buildAgentProxyUrl('http://localhost:4111', ['models'], '', 'POST'),
    ).toThrow('not available through the agent proxy');
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
