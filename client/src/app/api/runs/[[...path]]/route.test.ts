import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUserId, getDownstreamToken } = vi.hoisted(() => ({
  getUserId: vi.fn(),
  getDownstreamToken: vi.fn(),
}));

vi.mock('@/server/auth', () => ({ getUserId, getDownstreamToken }));

import { GET as handler, POST as postHandler } from './route';

const userId = 'user-1';
const ownedThreadId = 'main-agent-user-1-uuid-a';

function request(
  path: string,
  init: { method?: string; body?: string; search?: string } = {},
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/runs${path}${init.search ?? ''}`,
    {
      method: init.method ?? 'GET',
      ...(init.body !== undefined
        ? { body: init.body, headers: { 'Content-Type': 'application/json' } }
        : {}),
    },
  );
}

function context(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserId.mockResolvedValue(userId);
  getDownstreamToken.mockResolvedValue('service-token');
  fetchMock = vi.fn().mockResolvedValue(
    new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GET /api/runs/* proxy', () => {
  it('rejects unauthenticated callers', async () => {
    getUserId.mockResolvedValue(null);

    const response = await handler(
      request('/list', { search: '?resourceId=attacker' }),
      context(['list']),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('injects the session user as resourceId for the list endpoint', async () => {
    const response = await handler(request('/list'), context(['list']));

    expect(response.status).toBe(200);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/runs/list');
    expect(url.searchParams.get('resourceId')).toBe(userId);
  });

  it('validates thread ownership for the active-run endpoint', async () => {
    const response = await handler(
      request(
        '/active',
        { search: '?agentId=main-agent&threadId=main-agent-user-2-uuid-a' },
      ),
      context(['active']),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the active-run query with the derived resourceId', async () => {
    const response = await handler(
      request('/active', { search: `?agentId=main-agent&threadId=${ownedThreadId}` }),
      context(['active']),
    );

    expect(response.status).toBe(200);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/runs/active');
    expect(url.searchParams.get('resourceId')).toBe(userId);
    expect(url.searchParams.get('agentId')).toBe('main-agent');
    expect(url.searchParams.get('threadId')).toBe(ownedThreadId);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer service-token',
    );
  });

  it('appends the derived resourceId for run-scoped endpoints', async () => {
    const runId = 'run_20260101000000_00000001';
    await handler(
      request(`/${runId}/events`, { search: '?offset=5' }),
      context([runId, 'events']),
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe(`/runs/${runId}/events`);
    expect(url.searchParams.get('offset')).toBe('5');
    expect(url.searchParams.get('resourceId')).toBe(userId);
  });

  it('streams SSE responses through with event-stream defaults', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const runId = 'run_20260101000000_00000002';
    const response = await handler(
      request(`/${runId}/events`),
      context([runId, 'events']),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: {}\n\n');
  });

  it('rejects unknown run operations', async () => {
    const response = await handler(
      request('/unknown/op', { method: 'POST', body: '{}' }),
      context(['unknown', 'op']),
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe path segments', async () => {
    const response = await handler(
      request('/a%2Fb/events'),
      context(['a/b', 'events']),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs proxy', () => {
  it('injects the session user as resourceId and drops any client value', async () => {
    const response = await postHandler(
      request('', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'main-agent',
          threadId: ownedThreadId,
          prompt: 'hello',
          resourceId: 'attacker',
        }),
      }),
      context([]),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/runs');
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'main-agent',
      threadId: ownedThreadId,
      prompt: 'hello',
      resourceId: userId,
    });
  });

  it('rejects threads owned by another user', async () => {
    const response = await postHandler(
      request('', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'main-agent',
          threadId: 'main-agent-user-2-uuid-a',
          prompt: 'hello',
        }),
      }),
      context([]),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies', async () => {
    const invalid = await postHandler(
      request('', { method: 'POST', body: 'not json' }),
      context([]),
    );
    expect(invalid.status).toBe(400);

    const noThread = await postHandler(
      request('', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'main-agent', prompt: 'x' }),
      }),
      context([]),
    );
    expect(noThread.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers', async () => {
    getUserId.mockResolvedValue(null);

    const response = await postHandler(
      request('', {
        method: 'POST',
        body: JSON.stringify({
          agentId: 'main-agent',
          threadId: ownedThreadId,
          prompt: 'hello',
        }),
      }),
      context([]),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
