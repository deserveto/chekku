const BUCKETS = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const DEFAULT_CAP = 5;
// Soft ceiling on the bucket map. When exceeded, expired entries are swept
// lazily so a spoofed-IP attacker cannot grow the map without bound.
const MAX_BUCKETS = 10_000;
// Key used when no trusted proxy is configured. All anonymous clients share
// one bucket per scope, which prevents XFF spoofing from blowing past the cap
// at the cost of stricter-than-ideal fairness in dev/unsigned deployments.
const UNTRUSTED_IP_KEY = 'unknown';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/verify-email']);
// Everything under /public is share-token gated, not session gated: the page
// itself resolves the `?t=` token and 404s without it. Recipients of a share
// link have no account, so the session redirect must not intercept them.
const PUBLIC_PATH_PREFIXES = ['/public/'];

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Resolves the rate-limit key for a request.
 *
 * `x-forwarded-for` is attacker-controlled unless the deployment is behind a
 * trusted reverse proxy that overwrites the header. Callers must opt into
 * trusting it via `RATE_LIMIT_TRUST_PROXY=true`; otherwise every anonymous
 * client collapses onto a single shared bucket so the cap cannot be bypassed
 * by rotating the header value.
 */
export function resolveRateLimitKey(scope: string, ip: string): string {
  const trustProxy = process.env.RATE_LIMIT_TRUST_PROXY === 'true';
  const safeIp = trustProxy ? ip : UNTRUSTED_IP_KEY;
  return `${scope}:${safeIp}`;
}

export function consumeRateLimit(
  scope: string,
  ip: string,
  cap: number = DEFAULT_CAP,
): RateLimitResult {
  const key = resolveRateLimitKey(scope, ip);
  const now = Date.now();
  if (BUCKETS.size > MAX_BUCKETS) sweepExpired(now);
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

function sweepExpired(now: number): void {
  for (const [k, bucket] of BUCKETS) {
    if (bucket.resetAt <= now) BUCKETS.delete(k);
  }
}

export function resolveAuthRedirect({
  pathname,
  hasSession,
}: {
  pathname: string;
  hasSession: boolean;
}): string | null {
  // Only the exact auth pages bounce signed-in users away. Share pages under
  // /public stay reachable with a session so an owner can open their own link.
  if (hasSession && PUBLIC_PATHS.has(pathname)) return '/agents';
  // API routes own their auth contract: handlers enforce identity and return
  // bounded JSON errors (e.g. 403 from /api/storage/*). Redirecting them to
  // /login would return HTML to clients that call .json() on the response.
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (!hasSession && !isPublicPath(pathname)) return '/login';
  return null;
}

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function __resetRateLimitsForTests(): void {
  BUCKETS.clear();
}
