import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth', () => ({
  getDownstreamToken: vi.fn(async () => 'service-token'),
  getUserId: vi.fn(async () => 'local-user'),
}));
vi.mock('@/server/proxy-url', () => ({
  buildAgentProxyUrl: (baseUrl: string, path: string[], search: string) =>
    `${baseUrl}/${path.join('/')}${search}`,
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

describe('agent proxy', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env.AGENT_URL = 'http://agent.internal:4111';
  });

  it.each([
    ['POST', ['stored', 'agents'], { mcpClients: {} }],
    ['POST', ['stored', 'agents'], { mcpClients: { evil: { url: 'https://example.test/mcp' } } }],
    ['PATCH', ['stored', 'agents', 'demo'], { mcpClients: { garage: { url: 'https://example.test/mcp' } } }],
    ['PATCH', ['stored', 'agents', 'demo'], { mcpClients: { garage: { command: 'npx', args: ['evil'] } } }],
    ['PATCH', ['stored', 'agents', 'demo'], { mcpClients: { garage: { tools: {}, env: { API_KEY: 'secret' } } } }],
  ])('rejects noncanonical MCP config on %s /%s', async (method, path, body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const route = method === 'POST' ? POST : PATCH;

    const response = await route(request(method, path.join('/'), body), context(path));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid stored-agent MCP configuration.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards absent and canonical stored-agent MCP configuration', async () => {
    const fetchMock = vi.fn(async () => new Response('streamed', {
      status: 201,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const absent = await POST(request('POST', 'stored/agents', { id: 'plain' }), context(['stored', 'agents']));
    const canonical = await PATCH(request('PATCH', 'stored/agents/demo', {
      mcpClients: { garage: { tools: {} } },
    }), context(['stored', 'agents', 'demo']));

    expect(absent.status).toBe(201);
    await expect(absent.text()).resolves.toBe('streamed');
    expect(canonical.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps every supported proxy method available', () => {
    expect([GET, POST, PUT, PATCH, DELETE, HEAD]).toHaveLength(6);
    expect(new Set([GET, POST, PUT, PATCH, DELETE, HEAD])).toEqual(new Set([GET]));
  });
});
