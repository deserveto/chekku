import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getDownstreamToken: vi.fn(),
}));

vi.mock('@/server/auth', () => ({
  requireUserId: mocks.requireUserId,
  getDownstreamToken: mocks.getDownstreamToken,
}));

import { POST } from './route';

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/storage/social-posts/run-weekly-drafts', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserId.mockResolvedValue('user-1');
    mocks.getDownstreamToken.mockResolvedValue(null);
    // create-run returns a runId, start returns a message.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ runId: 'run-abc' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'started' }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates a run then starts it fire-and-forget and returns ok', async () => {
    const response = await POST();

    expect(mocks.requireUserId).toHaveBeenCalled();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // First call: create-run
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/workflows/weekly-social-drafts/create-run');
    // Second call: start with the returned runId
    expect(fetchMock.mock.calls[1]![0]).toContain('/api/workflows/weekly-social-drafts/start?runId=run-abc');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('returns 403 when the user is not signed in', async () => {
    mocks.requireUserId.mockRejectedValue(new Error('unauthorized'));

    const response = await POST();

    expect(response.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 502 when create-run fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'nope' }, { status: 500 }));

    const response = await POST();

    expect(response.status).toBe(502);
  });

  it('returns 502 when create-run returns no runId', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({}));

    const response = await POST();

    expect(response.status).toBe(502);
  });

  it('returns 404 in production (dev-only gate)', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await POST();
      expect(response.status).toBe(404);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
