import { describe, expect, it, vi } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

const { getUserId, requireUserId } = await import('./auth');

describe('getUserId', () => {
  it('returns the session user id when present', async () => {
    getSession.mockResolvedValue({ user: { id: 'u_123' } });
    await expect(getUserId()).resolves.toBe('u_123');
  });

  it('returns null when no session resolves', async () => {
    getSession.mockResolvedValue(null);
    await expect(getUserId()).resolves.toBeNull();
  });
});

describe('requireUserId', () => {
  it('redirects to /login when there is no session', async () => {
    getSession.mockResolvedValue(null);
    await expect(requireUserId()).rejects.toThrow('redirect:/login');
  });

  it('returns the id when a session is present', async () => {
    getSession.mockResolvedValue({ user: { id: 'u_456' } });
    await expect(requireUserId()).resolves.toBe('u_456');
  });
});
