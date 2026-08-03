const BUCKETS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const DEFAULT_CAP = 5;

const PUBLIC_PATHS = new Set(['/login', '/signup', '/verify-email']);

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function consumeRateLimit(
  scope: string,
  ip: string,
  cap: number = DEFAULT_CAP,
): RateLimitResult {
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const bucket = BUCKETS.get(key);
  if (!bucket || bucket.resetAt <= now) {
    BUCKETS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= cap) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

export function resolveAuthRedirect({
  pathname,
  hasSession,
}: {
  pathname: string;
  hasSession: boolean;
}): string | null {
  if (hasSession && PUBLIC_PATHS.has(pathname)) return '/agents';
  const isPublic = PUBLIC_PATHS.has(pathname) || pathname.startsWith('/api/auth');
  if (!hasSession && !isPublic) return '/login';
  return null;
}

export function __resetRateLimitsForTests(): void {
  BUCKETS.clear();
}
