import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth', () => ({
  getDownstreamToken: vi.fn(async () => 'service-token'),
  getUserId: vi.fn(async () => 'local-user'),
}));
vi.mock('@/server/proxy-url', () => ({
  normalizeAgentProxyPath: (path: string[]) => path[0] === 'api' ? path : ['api', ...path],
  buildAgentProxyUrl: (baseUrl: string, path: string[], search: string) => {
    const normalized = path[0] === 'api' ? path : ['api', ...path];
    return `${baseUrl}/${normalized.join('/')}${search}`;
  },
}));

import { DELETE, GET, HEAD, PATCH, POST, PUT } from './route';

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/agent/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type MutationMethod = 'POST' | 'PATCH' | 'PUT';

const mutationRoutes = { POST, PATCH, PUT } as const;
const mutationCases = [
  ['normalized', 'POST', ['stored', 'agents']],
  ['normalized', 'PATCH', ['stored', 'agents', 'demo']],
  ['normalized', 'PUT', ['stored', 'agents', 'demo']],
  ['aliased', 'POST', ['api', 'stored', 'agents']],
  ['aliased', 'PATCH', ['api', 'stored', 'agents', 'demo']],
  ['aliased', 'PUT', ['api', 'stored', 'agents', 'demo']],
] as const satisfies readonly (readonly [string, MutationMethod, readonly string[]])[];
const allowedMcpBodies = [
  ['absent', { id: 'plain' }],
  ['Garage', { mcpClients: { garage: { tools: {} } } }],
  ['SearXNG', { mcpClients: { searxng: { tools: {} } } }],
  ['Garage and SearXNG', {
    mcpClients: {
      garage: { tools: {} },
      searxng: { tools: {} },
    },
  }],
] as const;
const rejectedMcpBodies = [
  ['empty map', { mcpClients: {} }],
  ['null map', { mcpClients: null }],
  ['array map', { mcpClients: [] }],
  ['unknown id', { mcpClients: { unknown: { tools: {} } } }],
  ['prototype-named id', JSON.parse('{"mcpClients":{"__proto__":{"tools":{}}}}')],
  ['URL', { mcpClients: { searxng: { url: 'https://evil.test' } } }],
  ['command and args', { mcpClients: { searxng: { command: 'npx', args: ['evil'] } } }],
  ['package', { mcpClients: { searxng: { package: 'evil-package' } } }],
  ['environment', { mcpClients: { searxng: { tools: {}, env: { TOKEN: 'secret' } } } }],
  ['credentials', { mcpClients: { searxng: { tools: {}, credentials: { token: 'secret' } } } }],
  ['headers', { mcpClients: { searxng: { tools: {}, headers: { Authorization: 'secret' } } } }],
  ['tool override', { mcpClients: { searxng: { tools: { search_web: {} } } } }],
  ['extra client', {
    mcpClients: {
      garage: { tools: {} },
      searxng: { tools: {} },
      extra: {},
    },
  }],
  ['null client', { mcpClients: { searxng: null } }],
  ['array client', { mcpClients: { searxng: [] } }],
  ['null tools', { mcpClients: { searxng: { tools: null } } }],
  ['array tools', { mcpClients: { searxng: { tools: [] } } }],
  ['extra value field', { mcpClients: { searxng: { tools: {}, extra: true } } }],
] as const;

const allowedCases = mutationCases.flatMap(([shape, method, path]) =>
  allowedMcpBodies.map(([selection, body]) => [shape, method, path, selection, body] as const));
const rejectedCases = mutationCases.flatMap(([shape, method, path]) =>
  rejectedMcpBodies.map(([attack, body]) => [shape, method, path, attack, body] as const));

describe('agent proxy', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env.AGENT_URL = 'http://agent.internal:4111';
  });

  it.each(rejectedCases)('rejects %s %s /%s MCP %s', async (_shape, method, path, _attack, body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mutationRoutes[method](
      request(method, path.join('/'), body),
      context([...path]),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid stored-agent MCP configuration.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(allowedCases)('forwards %s %s /%s with %s MCP selection', async (
    _shape,
    method,
    path,
    _selection,
    body,
  ) => {
    const fetchMock = vi.fn(async () => new Response('streamed', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await mutationRoutes[method](
      request(method, path.join('/'), body),
      context([...path]),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('streamed');
    const upstreamPath = path[0] === 'api' ? path : ['api', ...path];
    expect(fetchMock).toHaveBeenCalledWith(
      `http://agent.internal:4111/${upstreamPath.join('/')}`,
      expect.objectContaining({ method }),
    );
  });

  it('keeps every supported proxy method available', () => {
    expect([GET, POST, PUT, PATCH, DELETE, HEAD]).toHaveLength(6);
    expect(new Set([GET, POST, PUT, PATCH, DELETE, HEAD])).toEqual(new Set([GET]));
  });
});
