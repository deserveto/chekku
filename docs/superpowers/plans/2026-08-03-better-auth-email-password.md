# Better Auth Email/Password Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `CHEKKU_LOCAL_USER_ID` dev seam with Better Auth email/password authentication that requires email verification before sign-in.

**Architecture:** Better Auth lives in the `client` workspace only. The `client/src/server/auth.ts:getUserId()` seam is the single rewrite point — it reads the Better Auth session and returns `session.user.id`. All ~15 pages switch their `resourceId` to it. The agent server is untouched and continues to receive `resourceId` through the proxy, gated by `AGENT_SERVICE_TOKEN`. A separate Postgres database `chekku_auth` (already provisioned) holds Better Auth tables; the client owns a dedicated pg pool.

**Tech Stack:** `better-auth` (Next.js App Router handler + react client + `better-auth/cookies` middleware helper), `pg` (auth pool to `chekku_auth`), raw `fetch` to Resend (reuses `RESEND_API_KEY` / `RESEND_FROM_EMAIL`), Vitest (colocated `.test.ts`, `renderToStaticMarkup` + `vi.mock` pattern).

## Global Constraints

- All auth code is **client workspace only**. Never import Better Auth or `pg` into `agent/` or `storage/`.
- Secrets are server-only and never enter client bundles: `BETTER_AUTH_SECRET`, `AUTH_DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `AGENT_SERVICE_TOKEN`.
- `chekku_auth` is the Better Auth database; `chekku_agent` stays Mastra-only. One Postgres instance, two databases (already created by `scripts/postgres/init-databases.sh`).
- `CHEKKU_LOCAL_USER_ID` is removed from every env example, config, and doc by the end of the plan.
- Thread-ownership semantics are unchanged: `resourceId` is still the Memory owner key — only its value source changes (env var -> verified session).
- Verification is strict: `requireEmailVerification: true` + `sendOnSignIn: true`. Unverified users never obtain a session.
- Tests use Vitest, colocated as `*.test.ts`, mirroring the existing `vi.hoisted` + `vi.mock` + `renderToStaticMarkup` style. Run a single test with `npx vitest run <path>` from the repo root.
- Code-defined agents stay shared globally; stored agents stay a global pool in v1 (per-user ownership is Phase 2, out of scope).
- No `resend` npm package — verification email uses raw `fetch` to `https://api.resend.com/emails`, matching the existing email pattern.
- No comments in code unless asked.

---

## File Structure

**New files (client workspace):**

| File | Responsibility |
|------|----------------|
| `client/src/server/email.ts` | `sendVerificationEmail({ to, url })`: Resend fetch when `RESEND_API_KEY` set, else console log. Server-only. |
| `client/src/server/auth-rate-limit.ts` | In-memory IP token-bucket `consumeRateLimit(scope, ip)` + pure `resolveAuthRedirect` helper. |
| `client/src/lib/auth.ts` | `betterAuth(...)` instance + `buildAuthOptions()` (testable). Server-only. |
| `client/src/lib/auth-client.ts` | `createAuthClient()` react client; re-exports `useSession`, `signIn`, `signUp`, `signOut`. |
| `client/src/app/api/auth/[...all]/route.ts` | `toNextJsHandler(auth)` GET/POST. |
| `client/src/middleware.ts` | Cookie gate + signup/resend rate limiting. |
| `client/src/app/login/page.tsx` | Email/password sign-in form. |
| `client/src/app/signup/page.tsx` | Email/password sign-up form -> "check your email" state. |
| `client/src/app/verify-email/page.tsx` | "Check your email" + resend + verified-success state. |

**Modified files:**

| File | Change |
|------|--------|
| `client/package.json` | Add `better-auth`, `pg`, `@types/pg`. |
| `client/src/server/auth.ts` | `getUserId()` reads session; add `requireUserId()`. |
| `client/src/app/**` (~15 pages) | `process.env.CHEKKU_LOCAL_USER_ID \|\| 'local-user'` -> `await requireUserId()`. |
| `client/src/components/studio/studio-nav.tsx` | Add logout button + session email display. |
| `client/.env.example`, root `.env.example`, `agent/.env.example` | Remove `CHEKKU_LOCAL_USER_ID`; add auth vars (client only). |
| `agent/src/config/env.ts` | Remove `CHEKKU_LOCAL_USER_ID` schema line. |
| `README.md`, `AGENTS.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md` | Update identity section + env tables. |

---

## Task 1: Verification email transport module

**Files:**
- Create: `client/src/server/email.ts`
- Test: `client/src/server/email.test.ts`

**Interfaces:**
- Produces: `sendVerificationEmail({ to: string; url: string }): Promise<void>` — consumed by `auth.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `client/src/server/email.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendVerificationEmail', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('posts to Resend with the configured sender when RESEND_API_KEY is set', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendVerificationEmail } = await import('./email');
    await sendVerificationEmail({
      to: 'user@example.test',
      url: 'https://app.test/api/auth/verify-email?token=x',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer rk_test',
    );
    const body = JSON.parse(init!.body as string);
    expect(body.from).toBe('no-reply@chekku.test');
    expect(body.to).toEqual(['user@example.test']);
    expect(body.html).toContain('https://app.test/api/auth/verify-email?token=x');
  });

  it('logs the url and skips Resend when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendVerificationEmail } = await import('./email');
    await sendVerificationEmail({
      to: 'user@example.test',
      url: 'https://app.test/v?token=y',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('https://app.test/v?token=y'),
    );
  });

  it('throws a fixed message when Resend rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    globalThis.fetch = fetchMock;

    const { sendVerificationEmail } = await import('./email');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.toThrow('Failed to send verification email.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/server/email.test.ts`
Expected: FAIL — module `./email` not found.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/server/email.ts`:

```ts
import 'server-only';

interface SendVerificationEmailArgs {
  to: string;
  url: string;
}

export async function sendVerificationEmail({
  to,
  url,
}: SendVerificationEmailArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[auth] verification email (dev console fallback): ${url}`);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    console.log(`[auth] verification email (RESEND_FROM_EMAIL unset): ${url}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Verify your Chekku email',
      html: `<p>Verify your email by clicking <a href="${url}">this link</a>.</p><p>${url}</p>`,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to send verification email.');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/server/email.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/server/email.ts client/src/server/email.test.ts
git commit -m "feat(auth): add Resend verification email transport with dev console fallback"
```

---

## Task 2: Auth rate limiter + redirect resolver

**Files:**
- Create: `client/src/server/auth-rate-limit.ts`
- Test: `client/src/server/auth-rate-limit.test.ts`

**Interfaces:**
- Produces: `consumeRateLimit(scope: string, ip: string, cap?: number): { allowed: boolean; retryAfterMs: number }`, `resolveAuthRedirect({ pathname, hasSession }): string | null`, `__resetRateLimitsForTests(): void`.
- Consumed by: `client/src/middleware.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `client/src/server/auth-rate-limit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/server/auth-rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/server/auth-rate-limit.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/server/auth-rate-limit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/server/auth-rate-limit.ts client/src/server/auth-rate-limit.test.ts
git commit -m "feat(auth): add in-memory signup/resend rate limiter and redirect resolver"
```

---

## Task 3: Better Auth config, client, deps, schema migration, route handler

**Files:**
- Modify: `client/package.json`
- Create: `client/src/lib/auth.ts`
- Create: `client/src/lib/auth-client.ts`
- Create: `client/src/app/api/auth/[...all]/route.ts`
- Create: `client/src/lib/auth.test.ts`
- Modify: `client/.env.example` (add `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`; leave `CHEKKU_LOCAL_USER_ID` removal for Task 8)

**Interfaces:**
- Consumes: `sendVerificationEmail` from `client/src/server/email.ts` (Task 1).
- Produces: `auth` (Better Auth instance) consumed by `server/auth.ts` (Task 4) and the route handler; `authClient` consumed by pages (Task 7).

- [ ] **Step 1: Add dependencies**

Run from repo root:

```bash
npm install better-auth pg --workspace client
npm install -D @types/pg --workspace client
```

- [ ] **Step 2: Write the failing test for the config builder**

Create `client/src/lib/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(public opts: unknown) {}
  },
}));

describe('buildAuthOptions', () => {
  it('requires email verification and resends on sign-in', async () => {
    const { buildAuthOptions } = await import('./auth');
    const options = buildAuthOptions({
      secret: 's',
      baseURL: 'https://app.test',
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
    });
    expect(options.baseURL).toBe('https://app.test');
    expect(options.secret).toBe('s');
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.emailVerification?.sendOnSignIn).toBe(true);
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe(
      'function',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run client/src/lib/auth.test.ts`
Expected: FAIL — module `./auth` not found.

- [ ] **Step 4: Write minimal implementation**

Create `client/src/lib/auth.ts`:

```ts
import 'server-only';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { sendVerificationEmail } from '@/server/email';

interface BuildAuthOptionsArgs {
  secret?: string;
  baseURL?: string;
  connectionString?: string;
}

export function buildAuthOptions(args: BuildAuthOptionsArgs) {
  return {
    baseURL: args.baseURL,
    secret: args.secret,
    database: new Pool({ connectionString: args.connectionString }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    emailVerification: {
      sendOnSignIn: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string };
        url: string;
      }) => {
        await sendVerificationEmail({ to: user.email, url });
      },
    },
  };
}

export const auth = betterAuth(
  buildAuthOptions({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    connectionString: process.env.AUTH_DATABASE_URL,
  }),
);
```

Create `client/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
export const useSession = authClient.useSession;
export const signIn = authClient.signIn;
export const signUp = authClient.signUp;
export const signOut = authClient.signOut;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run client/src/lib/auth.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Add the route handler**

Create `client/src/app/api/auth/[...all]/route.ts`:

```ts
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 7: Add env example entries**

Append to `client/.env.example` (read it first, then add these three lines; do not yet remove `CHEKKU_LOCAL_USER_ID`):

```
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_URL=postgresql://chekku:chekku@localhost:5432/chekku_auth
```

- [ ] **Step 8: Run the Better Auth schema migration**

Start Postgres if not already running: `docker compose up -d postgres`.

Create `client/.env.local` (gitignored) with real values mirroring the running Postgres (`POSTGRES_PASSWORD` from your shell env replaces the password):

```
BETTER_AUTH_SECRET=<32+ random chars>
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_URL=postgresql://chekku:<POSTGRES_PASSWORD>@localhost:5432/chekku_auth
```

Then run from the `client/` directory:

```bash
npx @better-auth/cli migrate
```

If the CLI does not auto-load `client/.env.local`, export the three vars in the shell first, then re-run. Confirm it creates the `user`, `account`, `session`, and `verification` tables in `chekku_auth`.

- [ ] **Step 9: Typecheck the client workspace**

Run: `npm run typecheck --workspace client`
Expected: PASS with no errors.

- [ ] **Step 10: Commit**

```bash
git add client/package.json client/package-lock.json client/src/lib/auth.ts client/src/lib/auth-client.ts client/src/lib/auth.test.ts client/src/app/api/auth client/.env.example
git commit -m "feat(auth): add Better Auth config, react client, handler, and chekku_auth schema"
```

---

## Task 4: Rewrite the identity seam (`getUserId` + `requireUserId`)

**Files:**
- Modify: `client/src/server/auth.ts`
- Test: `client/src/server/auth.test.ts` (new)

**Interfaces:**
- Consumes: `auth` from `client/src/lib/auth.ts` (Task 3).
- Produces: `getUserId(): Promise<string | null>`, `requireUserId(): Promise<string>` (redirects to `/login` on null). Consumed by all pages in Task 8.

- [ ] **Step 1: Write the failing test**

Create `client/src/server/auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/server/auth.test.ts`
Expected: FAIL — `getUserId` still returns `'local-user'`, assertions mismatch.

- [ ] **Step 3: Rewrite the seam**

Replace the entire contents of `client/src/server/auth.ts` with:

```ts
import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}

export async function requireUserId(): Promise<string> {
  const userId = await getUserId();
  if (!userId) redirect('/login');
  return userId;
}

export async function getDownstreamToken(userId: string): Promise<string | null> {
  void userId;
  return process.env.AGENT_SERVICE_TOKEN || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/server/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/server/auth.ts client/src/server/auth.test.ts
git commit -m "feat(auth): resolve user identity from the Better Auth session"
```

---

## Task 5: Middleware (route gate + rate limit wiring)

**Files:**
- Create: `client/src/middleware.ts`

**Interfaces:**
- Consumes: `getSessionCookie` from `better-auth/cookies`, `consumeRateLimit` and `resolveAuthRedirect` from `client/src/server/auth-rate-limit.ts` (Task 2).

Note: Next.js middleware cannot be unit-tested through `vi.mock` of itself usefully; the redirect + rate-limit logic is already covered by `auth-rate-limit.test.ts`. This task's gate is `npm run typecheck --workspace client` + manual verification.

- [ ] **Step 1: Write the middleware**

Create `client/src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { consumeRateLimit, resolveAuthRedirect } from '@/server/auth-rate-limit';

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? '127.0.0.1';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (request.method === 'POST') {
    if (pathname.endsWith('/sign-up/email')) {
      const result = consumeRateLimit('signup', clientIp(request));
      if (!result.allowed) {
        return new NextResponse('Too many requests.', {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
          },
        });
      }
    }
    if (pathname.endsWith('/send-verification-email')) {
      const result = consumeRateLimit('resend', clientIp(request));
      if (!result.allowed) {
        return new NextResponse('Too many requests.', {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
          },
        });
      }
    }
  }

  const target = resolveAuthRedirect({
    pathname,
    hasSession: Boolean(getSessionCookie(request)),
  });
  if (target) {
    return NextResponse.redirect(new URL(target, request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)',
  ],
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/middleware.ts
git commit -m "feat(auth): gate routes on the Better Auth session cookie and rate-limit signup/resend"
```

---

## Task 6: Sign-in, sign-up, verify-email pages

**Files:**
- Create: `client/src/app/login/page.tsx`
- Create: `client/src/app/signup/page.tsx`
- Create: `client/src/app/verify-email/page.tsx`
- Test: `client/src/app/auth-pages.test.ts`

**Interfaces:**
- Consumes: `authClient` from `client/src/lib/auth-client.ts` (Task 3).

The repo renders pages via `renderToStaticMarkup` and asserts on the HTML string (see `client/src/app/reports/reports-pages.test.ts`). Client components render their initial markup the same way.

- [ ] **Step 1: Write the failing test**

Create `client/src/app/auth-pages.test.ts`:

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: { email: vi.fn(async () => ({ error: null })) },
    signUp: { email: vi.fn(async () => ({ error: null })) },
    useSession: () => ({ data: null, isPending: false }),
    signOut: vi.fn(async () => ({ success: true })),
    emailVerification: {
      sendVerificationEmail: vi.fn(async () => ({ error: null })),
    },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === 'status' ? '' : '') }),
}));

describe('login page', () => {
  it('renders an email/password sign-in form and a signup link', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(await LoginPage());
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/signup"');
  });
});

describe('signup page', () => {
  it('renders an email/password sign-up form and a login link', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const markup = renderToStaticMarkup(await SignupPage());
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/login"');
  });
});

describe('verify-email page', () => {
  it('renders the check-your-email state with a resend button', async () => {
    const VerifyPage = (await import('./verify-email/page')).default;
    const markup = renderToStaticMarkup(await VerifyPage());
    expect(markup).toContain('Check your email');
    expect(markup).toMatch(/resend/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: FAIL — page modules not found.

- [ ] **Step 3: Implement the login page**

Create `client/src/app/login/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-in failed.');
      return;
    }
    router.push('/agents');
  }

  return (
    <main>
      <h1>Sign in to Chekku</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p>
        No account? <Link href="/signup">Sign up</Link>
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Implement the signup page**

Create `client/src/app/signup/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: '/verify-email',
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed.');
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main>
        <h1>Check your email</h1>
        <p>
          We sent a verification link to <strong>{email}</strong>. Click it to
          verify your account, then sign in.
        </p>
        <p>
          <Link href="/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your Chekku account</h1>
      <form onSubmit={onSubmit}>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoComplete="name"
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="new-password"
            minLength={8}
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Sign up'}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
```

- [ ] **Step 5: Implement the verify-email page**

Create `client/src/app/verify-email/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function VerifyEmailPage() {
  const search = useSearchParams();
  const verified = search.get('status') === 'verified';
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.emailVerification.sendVerificationEmail({
      email,
      callbackURL: '/verify-email',
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Could not resend verification email.');
      return;
    }
    setSent(true);
  }

  if (verified) {
    return (
      <main>
        <h1>Email verified</h1>
        <p>Your email is verified. You can sign in now.</p>
        <p>
          <Link href="/login">Sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Check your email</h1>
      <p>
        We sent a verification link when you signed up. Click it to verify your
        account.
      </p>
      <form onSubmit={onResend}>
        <label>
          Resend to
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Resend verification'}
        </button>
        {sent ? <p>If that account exists, a new link is on its way.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p>
        <Link href="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add client/src/app/login client/src/app/signup client/src/app/verify-email client/src/app/auth-pages.test.ts
git commit -m "feat(auth): add login, signup, and verify-email pages"
```

---

## Task 7: Logout + session display in studio nav

**Files:**
- Modify: `client/src/components/studio/studio-nav.tsx`
- Modify: `client/src/components/studio/studio-nav.test.ts` (extend existing)

**Interfaces:**
- Consumes: `authClient.useSession`, `authClient.signOut` from `client/src/lib/auth-client.ts`.

Read `client/src/components/studio/studio-nav.tsx` and `studio-nav.test.ts` first to match the existing component structure and test mocking style before editing.

- [ ] **Step 1: Extend the existing test**

Add to `client/src/components/studio/studio-nav.test.ts` (mirror its existing `vi.mock` block — if `@/lib/auth-client` is not already mocked, add a mock returning `useSession: () => ({ data: { user: { email: 'owner@chekku.test' } } })` and `signOut: vi.fn(async () => ({ success: true }))`):

```ts
it('renders the signed-in email and a logout control', async () => {
  const { renderNavMarkup } = await import('./studio-nav');
  const markup = await renderNavMarkup();
  expect(markup).toContain('owner@chekku.test');
  expect(markup).toMatch(/log out|sign out/i);
});
```

If the existing test file does not export a `renderNavMarkup` helper, render the default export directly with `renderToStaticMarkup` the same way the existing cases do, and mock `@/lib/auth-client` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/studio/studio-nav.test.ts`
Expected: FAIL — new assertion missing email / logout control.

- [ ] **Step 3: Add the logout control to the nav**

Edit `client/src/components/studio/studio-nav.tsx`: import `authClient` from `@/lib/auth-client`, read `const { data: session } = authClient.useSession()` (guard for `null`), render `session?.user?.email` when present, and a button that calls `await authClient.signOut()` then `router.push('/login')`. Match the existing markup patterns (same element types, class names) so the existing tests still pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/components/studio/studio-nav.test.ts`
Expected: PASS (existing + new assertions).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/studio/studio-nav.tsx client/src/components/studio/studio-nav.test.ts
git commit -m "feat(auth): show signed-in email and logout control in studio nav"
```

---

## Task 8: Migrate `resourceId` call sites off `CHEKKU_LOCAL_USER_ID`

**Files (modify each — replace `const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';` with `const resourceId = await requireUserId();`):**
- `client/src/app/chat/page.tsx`
- `client/src/app/agents/page.tsx`
- `client/src/app/agents/new/page.tsx`
- `client/src/app/agents/[id]/edit/page.tsx`
- `client/src/app/reports/page.tsx`
- `client/src/app/reports/weekly/page.tsx`
- `client/src/app/reports/[reportId]/page.tsx`
- `client/src/app/reports/competitive/page.tsx`
- `client/src/app/reports/competitive/[analysisId]/page.tsx`
- `client/src/app/reports/competitive/[analysisId]/slides/page.tsx`
- `client/src/app/social-posts/page.tsx`
- `client/src/app/social-posts/[postId]/page.tsx`

Each page is already an `async` server component (the current `const resourceId = ...` runs inside it). Import `requireUserId` from `@/server/auth` where not already imported.

**Interfaces:**
- Consumes: `requireUserId` from `client/src/server/auth.ts` (Task 4).

- [ ] **Step 1: Update each file**

For each listed file, change:

```ts
const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
```

to:

```ts
const resourceId = await requireUserId();
```

and add `requireUserId` to the existing `import { ... } from '@/server/auth';` (create the import if the file has none).

- [ ] **Step 2: Confirm no remaining references**

Run: `rg -n "CHEKKU_LOCAL_USER_ID" client/src/app`
Expected: no matches.

- [ ] **Step 3: Run the full client test suite + typecheck**

Run: `npx vitest run client && npm run typecheck --workspace client`
Expected: PASS. The existing page tests (`reports-pages.test.ts`, `social-posts-pages.test.ts`, `competitive-pages.test.ts`) and thread-ownership tests must still pass; they mock `@/server/pm-reports` / `@/server/social-posts` upstream of `requireUserId`, so add `vi.mock('@/server/auth', () => ({ requireUserId: async () => 'local-user', getUserId: async () => 'local-user' }))` to any page test that now fails because it renders a page calling `requireUserId` (mirror the existing `vi.mock('server-only', ...)` pattern at the top of those files).

- [ ] **Step 4: Commit**

```bash
git add client/src/app
git commit -m "refactor(auth): source Memory resourceId from the verified session"
```

---

## Task 9: Remove `CHEKKU_LOCAL_USER_ID` + update docs

**Files:**
- Modify: `client/.env.example`, root `.env.example`, `agent/.env.example`
- Modify: `agent/src/config/env.ts`
- Modify: `README.md`, `AGENTS.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Remove the env var from examples and the agent config**

- In `client/.env.example`, root `.env.example`, and `agent/.env.example`: delete the `CHEKKU_LOCAL_USER_ID=local-user` line.
- In `agent/src/config/env.ts`: delete the `CHEKKU_LOCAL_USER_ID: z.string().default('local-user'),` schema line (and any destructure of it elsewhere in that file — search first with `rg -n "CHEKKU_LOCAL_USER_ID" agent/src`).

- [ ] **Step 2: Confirm zero source references**

Run: `rg -n "CHEKKU_LOCAL_USER_ID" client agent storage`
Expected: no matches outside `docs/` (docs are updated next).

- [ ] **Step 3: Update documentation**

- `README.md` (env tables around lines 217, 243, 504): remove the `CHEKKU_LOCAL_USER_ID` rows; add rows for `BETTER_AUTH_SECRET` (Yes), `BETTER_AUTH_URL` (Yes, e.g. `http://localhost:3000`), `AUTH_DATABASE_URL` (Yes, points at `chekku_auth`). Replace the "development seam, not production authentication" note with a one-line pointer to the Better Auth sign-in flow.
- `docs/OPERATIONS.md` (lines ~106, ~312, ~635): remove `CHEKKU_LOCAL_USER_ID` from the dev env example; update the report-interface identity description to say the session resolves the user id; delete the "replace `CHEKKU_LOCAL_USER_ID` with real authentication" cleanup item. Add a short "Authentication" subsection: sign up at `/signup`, verify via email (Resend in prod, server console in dev when `RESEND_API_KEY` unset), sign in at `/login`; required env vars `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`.
- `docs/ARCHITECTURE.md` (line ~396): replace the OIDC-future sentence with a statement that the identity seam now resolves from the Better Auth session and `resourceId` semantics are unchanged.
- `AGENTS.md` "Client proxy and identity" section: replace the `CHEKKU_LOCAL_USER_ID` bullet with: "`getUserId()` / `requireUserId()` in `client/src/server/auth.ts` resolve the authenticated user from the Better Auth session cookie; `resourceId` (Memory thread ownership) equals `session.user.id`. Thread-ownership semantics are unchanged from the `CHEKKU_LOCAL_USER_ID` era." Add the new env vars to the models-and-secrets conventions; record that per-user stored-agent ownership is deferred to a later phase.

- [ ] **Step 4: Run full check + build**

Run: `npm run check && npm run build`
Expected: both PASS.

- [ ] **Step 5: Whitespace check**

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(auth): remove CHEKKU_LOCAL_USER_ID seam and document Better Auth identity"
```

---

## Final Verification (run before declaring done)

- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] `rg -n "CHEKKU_LOCAL_USER_ID" .` returns no source/example/doc matches (only this plan + the design spec, which are historical).
- [ ] Manual smoke (dev): with Postgres up and `client/.env.local` set, `npm run dev:client`, sign up at `/signup`, observe the verification URL in the server console (dev fallback), open it, land on `/verify-email?status=verified`, sign in at `/login`, reach `/agents`, and confirm `/chat` threads are scoped to the session user.

---

## Notes For The Implementer

- **Better Auth client method names** (`authClient.signIn.email`, `authClient.signUp.email`, `authClient.emailVerification.sendVerificationEmail`, `authClient.useSession`, `authClient.signOut`) are the current Better Auth React API. If a method name differs in the installed version, check `node_modules/better-auth/dist/client-react` and adjust `auth-client.ts` + the page calls; the test mocks mirror these names so update both together.
- **CLI migration command** is `npx @better-auth/cli migrate`. If it cannot find the config from the repo root, run it from `client/` and ensure `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `AUTH_DATABASE_URL` are in the shell environment or `client/.env.local` (the CLI loads `.env` files in its cwd).
- **`AUTH_DATABASE_URL`** must point at `chekku_auth`, not `chekku_agent`. Use the same user/password as `DATABASE_URL` (the `chekku` role created by `compose.yaml`).
- **Middleware matcher** excludes static asset extensions so auth pages and API stay fast; adjust only if a route is accidentally gated or excluded.
- **Verify-email success state:** the page shows a dedicated "verified" view when `?status=verified` is present, but Better Auth's redirect after `GET /api/auth/verify-email` may not append that param by default. If verification lands on `/verify-email` without the param, the page still renders the "check your email / resend / sign in" state, which is a valid landing — the verified-success view is a UX enhancement. If you want the confirmed-success view reliably, inspect the installed Better Auth version's redirect behavior (it may pass `callbackURL` query differently) and adjust the `search.get('status')` check, or have the page call `authClient.useSession()` + `getSession` to detect `emailVerified` instead of relying on the URL param.
- **Phase 2 (out of scope here):** per-user stored-agent ownership (agent-workspace `ownerId` + filter), password reset pages, SSO/OIDC, agent-server-side session validation, distributed rate limiting.
