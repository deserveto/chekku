import { beforeEach, describe, expect, it } from 'vitest';

describe('consumeRateLimit', () => {
  beforeEach(async () => {
    const { __resetRateLimitsForTests } = await import('./auth-rate-limit');
    __resetRateLimitsForTests();
  });

  it('allows up to the cap then denies within the window', async () => {
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      expect(consumeRateLimit('signup', '1.2.3.4').allowed).toBe(true);
    }
    const denied = consumeRateLimit('signup', '1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('isolates scopes and ip addresses', async () => {
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      consumeRateLimit('signup', '1.1.1.1');
    }
    expect(consumeRateLimit('signup', '2.2.2.2').allowed).toBe(true);
    expect(consumeRateLimit('resend', '1.1.1.1').allowed).toBe(true);
  });
});

describe('resolveAuthRedirect', () => {
  it('sends authenticated users away from auth pages to /agents', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(resolveAuthRedirect({ pathname: '/login', hasSession: true })).toBe(
      '/agents',
    );
    expect(resolveAuthRedirect({ pathname: '/signup', hasSession: true })).toBe(
      '/agents',
    );
  });

  it('sends unauthenticated users on protected routes to /login', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({ pathname: '/agents', hasSession: false }),
    ).toBe('/login');
    expect(
      resolveAuthRedirect({ pathname: '/chat', hasSession: false }),
    ).toBe('/login');
  });

  it('lets public auth pages and the handler pass through', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({ pathname: '/login', hasSession: false }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({
        pathname: '/api/auth/sign-in/email',
        hasSession: false,
      }),
    ).toBeNull();
  });
});
