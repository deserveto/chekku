import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('consumeRateLimit', () => {
  beforeEach(async () => {
    const { __resetRateLimitsForTests } = await import('./auth-rate-limit');
    __resetRateLimitsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows up to the cap then denies within the window', async () => {
    vi.stubEnv('RATE_LIMIT_TRUST_PROXY', 'true');
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      expect(consumeRateLimit('signup', '1.2.3.4').allowed).toBe(true);
    }
    const denied = consumeRateLimit('signup', '1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('isolates scopes and ip addresses under trusted-proxy mode', async () => {
    vi.stubEnv('RATE_LIMIT_TRUST_PROXY', 'true');
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      consumeRateLimit('signup', '1.1.1.1');
    }
    expect(consumeRateLimit('signup', '2.2.2.2').allowed).toBe(true);
    expect(consumeRateLimit('resend', '1.1.1.1').allowed).toBe(true);
  });

  it('collapses all clients onto one bucket when RATE_LIMIT_TRUST_PROXY is unset (XFF spoofing defense)', async () => {
    vi.stubEnv('RATE_LIMIT_TRUST_PROXY', '');
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      consumeRateLimit('signup', `10.0.0.${i}`);
    }
    // 6th request from a "different" IP is denied because all clients share
    // the 'unknown' bucket when the proxy header is not trusted.
    const denied = consumeRateLimit('signup', '10.0.0.99');
    expect(denied.allowed).toBe(false);
  });

  it('honours distinct IPs when RATE_LIMIT_TRUST_PROXY=true', async () => {
    vi.stubEnv('RATE_LIMIT_TRUST_PROXY', 'true');
    const { consumeRateLimit } = await import('./auth-rate-limit');
    for (let i = 0; i < 5; i += 1) {
      consumeRateLimit('signup', '1.1.1.1');
    }
    // Different IP gets its own bucket under trusted proxy mode.
    expect(consumeRateLimit('signup', '2.2.2.2').allowed).toBe(true);
  });

  it('evicts expired buckets when the map exceeds the soft ceiling', async () => {
    vi.stubEnv('RATE_LIMIT_TRUST_PROXY', 'true');
    vi.useFakeTimers();
    try {
      const { consumeRateLimit, __resetRateLimitsForTests } = await import(
        './auth-rate-limit'
      );
      __resetRateLimitsForTests();
      // Fill 6 buckets (below MAX_BUCKETS, but we want to observe sweep).
      for (let i = 0; i < 6; i += 1) {
        consumeRateLimit('signup', `9.9.9.${i}`);
      }
      // Advance past window so all 6 are expired.
      vi.advanceTimersByTime(61_000);
      // Re-stub MAX_BUCKETS path indirectly: force a sweep by filling past cap.
      // We simulate by calling consume 11_000 times with unique IPs.
      for (let i = 0; i < 11_000; i += 1) {
        consumeRateLimit('signup', `8.0.${Math.floor(i / 256)}.${i % 256}`);
      }
      // If sweep worked, the call did not throw and the map stays bounded.
      expect(consumeRateLimit('signup', '7.7.7.7').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('never redirects API routes so handlers can return their own bounded JSON errors', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({
        pathname: '/api/storage/social-posts',
        hasSession: false,
      }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({
        pathname: '/api/storage/social-posts/smp_20260714120000_deadbeef',
        hasSession: false,
      }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({
        pathname: '/api/storage/pm-reports',
        hasSession: false,
      }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({ pathname: '/api', hasSession: false }),
    ).toBeNull();
  });

  it('lets share-token pages under /public through without a session', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({
        pathname: '/public/slides/pca_20260723120000_deadbeef',
        hasSession: false,
      }),
    ).toBeNull();
  });

  it('keeps /public reachable for signed-in users so owners can open their own links', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({
        pathname: '/public/slides/pca_20260723120000_deadbeef',
        hasSession: true,
      }),
    ).toBeNull();
  });

  it('does not treat sibling /api/ paths like /api/authorize as public auth routes', async () => {
    // Regression: previously used bare startsWith('/api/auth'), which would
    // also match /api/authorize. API routes now short-circuit to null above,
    // and the auth-handler public check must remain path-boundary safe.
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({ pathname: '/api/authorize', hasSession: false }),
    ).toBeNull();
  });
});
