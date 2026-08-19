# Password Reset and Signup Confirm-Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Better Auth native email-link password reset flow (`/forgot-password` + `/reset-password`) and a confirm-password field on signup.

**Architecture:** Server-side, `buildAuthOptions` gains a required injected `sendResetPassword` transport (same pattern as `sendVerificationEmail`), backed by a new `sendResetPasswordEmail` in `client/src/server/email.ts` that shares a private Resend delivery helper with the verification sender. Client-side, two new public pages mirror the existing `/verify-email` page pattern (`AuthLayout`, `Suspense`-wrapped content, bounded alerts). No new env vars, no schema migration, no agent-server change.

**Tech Stack:** Next.js App Router (client workspace), Better Auth 1.6.25, Vitest + jsdom, Resend HTTP API via `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-16-password-reset-and-confirm-password-design.md`

## Global Constraints

- Better Auth 1.6.25 client methods are `authClient.requestPasswordReset({ email, redirectTo })` and `authClient.resetPassword({ newPassword, token })`. The legacy name `forgetPassword` does NOT exist in this version — verified against `node_modules/better-auth/dist/api/routes/password.mjs` (endpoints `/request-password-reset`, `/reset-password/:token`, `/reset-password`).
- `client/src/lib/auth-options.ts` must stay free of `server-only` imports (loaded by `@better-auth/cli` through `auth-migrate.ts`).
- `revokeSessionsOnPasswordReset: true` must be set on `emailAndPassword`.
- No user enumeration: generic success text on `/forgot-password`; fixed invalid-link message on `/reset-password`; raw error codes/provider details never rendered.
- Errors are fixed, bounded strings; never leak Resend responses, endpoints, headers, or recipient data.
- Rate limit: one new scope `password-reset` for `POST` paths ending in `/request-password-reset` (default 5/min cap, same shape as existing scopes).
- Tests: Vitest only, run single files from the repo root as `npx vitest run <path>`. jsdom tests carry the `// @vitest-environment jsdom` header.
- No comments in code unless mirroring an existing explanatory pattern (existing files use explanatory comments at non-obvious seams; match that register sparsely).
- Commit style: `feat(auth): ...` / `test(auth): ...` lowercase imperative, matching `git log --oneline` style.
- TypeScript strict mode; named exports; import order: external packages, blank line, internal modules.

---

### Task 1: `sendResetPasswordEmail` in the server email module

**Files:**
- Modify: `client/src/server/email.ts`
- Test: `client/src/server/email.test.ts`

**Interfaces:**
- Consumes: none (leaf module).
- Produces: `sendResetPasswordEmail({ to: string, url: string }): Promise<void>` — consumed by Task 2. Existing `sendVerificationEmail` signature unchanged.

- [ ] **Step 1: Write the failing tests**

In `client/src/server/email.test.ts`, add a new `describe` block after the existing `sendVerificationEmail` block (do not touch existing tests):

```typescript
describe('sendResetPasswordEmail', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('posts to Resend with the reset subject and link when RESEND_API_KEY is set', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock;

    const { sendResetPasswordEmail } = await import('./email');
    await sendResetPasswordEmail({
      to: 'user@example.test',
      url: 'https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset-password',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.subject).toBe('Reset your Chekku password');
    expect(body.to).toEqual(['user@example.test']);
    expect(body.html).toContain(
      'https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset-password',
    );
  });

  it('logs the url and skips Resend when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendResetPasswordEmail } = await import('./email');
    await sendResetPasswordEmail({
      to: 'user@example.test',
      url: 'https://app.test/reset?token=y',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('https://app.test/reset?token=y'),
    );
  });

  it('throws a fixed message when Resend rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    globalThis.fetch = fetchMock;

    const { sendResetPasswordEmail } = await import('./email');
    await expect(
      sendResetPasswordEmail({
        to: 'u@e.test',
        url: 'https://app.test/reset?token=z',
      }),
    ).rejects.toThrow('Failed to send reset password email.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/server/email.test.ts`
Expected: FAIL — `sendResetPasswordEmail` is not exported (`TypeError: sendResetPasswordEmail is not a function` or import shape mismatch).

- [ ] **Step 3: Implement**

Replace the full contents of `client/src/server/email.ts` with (extracts the shared Resend delivery path into one private helper; both senders keep identical behavior and error strings):

```typescript
import 'server-only';

interface SendAuthMailArgs {
  to: string;
  url: string;
}

export async function sendVerificationEmail({
  to,
  url,
}: SendAuthMailArgs): Promise<void> {
  await deliverAuthEmail({
    to,
    subject: 'Verify your Chekku email',
    html: `<p>Verify your email by clicking <a href="${url}">this link</a>.</p><p>${url}</p>`,
    consoleFallbackLine: `[auth] verification email (dev console fallback): ${url}`,
    failureMessage: 'Failed to send verification email.',
  });
}

export async function sendResetPasswordEmail({
  to,
  url,
}: SendAuthMailArgs): Promise<void> {
  await deliverAuthEmail({
    to,
    subject: 'Reset your Chekku password',
    html: `<p>Reset your password by clicking <a href="${url}">this link</a>. The link expires in one hour and works once.</p><p>${url}</p>`,
    consoleFallbackLine: `[auth] reset password email (dev console fallback): ${url}`,
    failureMessage: 'Failed to send reset password email.',
  });
}

async function deliverAuthEmail({
  to,
  subject,
  html,
  consoleFallbackLine,
  failureMessage,
}: {
  to: string;
  subject: string;
  html: string;
  consoleFallbackLine: string;
  failureMessage: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(consoleFallbackLine);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error(failureMessage);
  }

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch {
    throw new Error(failureMessage);
  }

  if (!response.ok) {
    cancelBody(response.body);
    throw new Error(failureMessage);
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the fixed client error.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/server/email.test.ts`
Expected: PASS — all existing `sendVerificationEmail` tests plus the 3 new `sendResetPasswordEmail` tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/server/email.ts client/src/server/email.test.ts
git commit -m "feat(auth): add sendResetPasswordEmail with shared resend delivery"
```

---

### Task 2: Wire `sendResetPassword` through `buildAuthOptions`

**Files:**
- Modify: `client/src/lib/auth-options.ts`
- Modify: `client/src/lib/auth.ts`
- Modify: `client/src/lib/auth-migrate.ts`
- Test: `client/src/lib/auth.test.ts`

**Interfaces:**
- Consumes: `sendResetPasswordEmail` from Task 1.
- Produces: `buildAuthOptions(args)` now REQUIRES `sendResetPassword: (args: { user: { email: string }; url: string }) => Promise<void>`; returned options have `emailAndPassword.revokeSessionsOnPasswordReset === true` and `emailAndPassword.sendResetPassword` wired to the injected transport.

- [ ] **Step 1: Update the failing tests**

In `client/src/lib/auth.test.ts`:

1. Every existing `buildAuthOptions({...})` call (there are three, in the three `it` blocks) must gain `sendResetPassword: async () => {},` next to the existing `sendVerificationEmail` line. Example for the first call:

```typescript
    const options = buildAuthOptions({
      secret: 's',
      baseURL: 'https://app.test',
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
    });
```

2. Append two new `it` blocks inside `describe('buildAuthOptions')`:

```typescript
  it('revokes every session when a password is reset', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
    });
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it('delivers reset mail through the injected transport', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const sent: Array<{ user: { email: string }; url: string }> = [];
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async (args) => {
        sent.push(args);
      },
    });

    await options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'person@example.test' },
      url: 'https://app.test/api/auth/reset-password/tok',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].user).toEqual({ email: 'person@example.test' });
    expect(sent[0].url).toContain('reset-password/tok');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/lib/auth.test.ts`
Expected: FAIL — `revokeSessionsOnPasswordReset` undefined; `sendResetPassword` missing from options/args type.

- [ ] **Step 3: Implement**

Replace the full contents of `client/src/lib/auth-options.ts` with:

```typescript
// Shared Better Auth configuration. Deliberately free of `import 'server-only'`
// and of any import that reaches it: @better-auth/cli loads this module (through
// auth-migrate.ts) to derive the schema, and it aborts on any config whose
// import graph touches `server-only`. Runtime server code composes these options
// with the real email transports in auth.ts, which keeps the `server-only` guard.
import { Pool } from 'pg';
import { withEmailVerificationCallback } from './auth-redirects';

interface SendVerificationEmail {
  (args: { user: { email: string }; url: string }): Promise<void>;
}

interface SendResetPassword {
  (args: { user: { email: string }; url: string }): Promise<void>;
}

interface BuildAuthOptionsArgs {
  secret?: string;
  baseURL?: string;
  connectionString?: string;
  // Required rather than defaulted: a no-op fallback would silently disable
  // verification delivery, and every signup depends on that mail arriving.
  sendVerificationEmail: SendVerificationEmail;
  // Required for the same reason: reset links must actually be delivered.
  sendResetPassword: SendResetPassword;
}

export function buildAuthOptions(args: BuildAuthOptionsArgs) {
  return {
    baseURL: args.baseURL,
    secret: args.secret,
    database: new Pool({ connectionString: args.connectionString }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: args.sendResetPassword,
    },
    emailVerification: {
      sendOnSignIn: true,
      // Pin the callback on every outgoing link rather than at each call site:
      // the `sendOnSignIn` resend is issued by Better Auth itself and no client
      // call can parameterise it. See `withEmailVerificationCallback`.
      sendVerificationEmail: async (verification: {
        user: { email: string };
        url: string;
      }) => {
        await args.sendVerificationEmail({
          user: verification.user,
          url: withEmailVerificationCallback(verification.url),
        });
      },
    },
  };
}
```

Replace the full contents of `client/src/lib/auth.ts` with:

```typescript
import 'server-only';
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from './auth-options';
import { sendResetPasswordEmail, sendVerificationEmail } from '@/server/email';

export const auth = betterAuth(
  buildAuthOptions({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    connectionString: process.env.AUTH_DATABASE_URL,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, url });
    },
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail({ to: user.email, url });
    },
  }),
);
```

In `client/src/lib/auth-migrate.ts`, add the stub next to the existing verification stub (lines 20-21):

```typescript
    // Never invoked — the CLI derives the schema without sending mail.
    sendVerificationEmail: async () => {},
    sendResetPassword: async () => {},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/lib/auth.test.ts`
Expected: PASS — 5 tests (3 updated + 2 new).

Also run the server auth seam tests to catch import fallout:

Run: `npx vitest run client/src/server/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/auth-options.ts client/src/lib/auth.ts client/src/lib/auth-migrate.ts client/src/lib/auth.test.ts
git commit -m "feat(auth): wire native password reset into better auth options"
```

---

### Task 3: Public paths and middleware rate limit

**Files:**
- Modify: `client/src/server/auth-rate-limit.ts:12`
- Modify: `client/src/middleware.ts:36-46`
- Test: `client/src/server/auth-rate-limit.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `/forgot-password` and `/reset-password` resolve as public auth pages in `resolveAuthRedirect`; `POST` paths ending in `/request-password-reset` are rate-limited under scope `password-reset` (5/min default cap).

- [ ] **Step 1: Write the failing test**

In `client/src/server/auth-rate-limit.test.ts`, inside `describe('resolveAuthRedirect')`, after the `sends authenticated users away from auth pages to /agents` test, add:

```typescript
  it('treats the password reset pages as public auth pages', async () => {
    const { resolveAuthRedirect } = await import('./auth-rate-limit');
    expect(
      resolveAuthRedirect({ pathname: '/forgot-password', hasSession: false }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({ pathname: '/reset-password', hasSession: false }),
    ).toBeNull();
    expect(
      resolveAuthRedirect({ pathname: '/forgot-password', hasSession: true }),
    ).toBe('/agents');
    expect(
      resolveAuthRedirect({ pathname: '/reset-password', hasSession: true }),
    ).toBe('/agents');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/server/auth-rate-limit.test.ts`
Expected: FAIL — signed-out `/forgot-password` returns `/login` (not public), signed-in returns `/login` too.

- [ ] **Step 3: Implement**

In `client/src/server/auth-rate-limit.ts` line 12, change:

```typescript
const PUBLIC_PATHS = new Set(['/login', '/signup', '/verify-email']);
```

to:

```typescript
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);
```

In `client/src/middleware.ts`, after the `pathname.endsWith('/send-verification-email')` block (lines 36-46) and still inside the `if (request.method === 'POST')` block, add:

```typescript
    if (pathname.endsWith('/request-password-reset')) {
      const result = consumeRateLimit('password-reset', clientIp(request));
      if (!result.allowed) {
        return new NextResponse('Too many requests.', {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
          },
        });
      }
    }
```

(The middleware itself has no unit-test file in this repo — the rate-limit primitive `consumeRateLimit` is covered by its own suite; the scope string `password-reset` is exercised again in the Task 7 manual smoke.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/server/auth-rate-limit.test.ts`
Expected: PASS — all existing tests plus the new one.

- [ ] **Step 5: Commit**

```bash
git add client/src/server/auth-rate-limit.ts client/src/server/auth-rate-limit.test.ts client/src/middleware.ts
git commit -m "feat(auth): public reset pages and password-reset rate limit scope"
```

---

### Task 4: `/forgot-password` page

**Files:**
- Create: `client/src/app/forgot-password/page.tsx`
- Test: `client/src/app/auth-pages.test.ts`

**Interfaces:**
- Consumes: `AuthLayout` (`client/src/components/auth/auth-layout.tsx`), `authClient.requestPasswordReset` from `client/src/lib/auth-client.ts`.
- Produces: route `GET /forgot-password` rendering an email form; on submit calls `authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`; generic success state regardless of account existence.

- [ ] **Step 1: Add the authClient mock surface**

In `client/src/app/auth-pages.test.ts`, extend the hoisted mocks (lines 13-17) and the `vi.mock('@/lib/auth-client', ...)` factory (lines 23-31):

```typescript
const authMocks = vi.hoisted(() => ({
  signInEmail: vi.fn(async () => ({ error: null })),
  signUpEmail: vi.fn(async () => ({ error: null })),
  sendVerificationEmail: vi.fn(async () => ({ error: null })),
  requestPasswordReset: vi.fn(async () => ({ error: null })),
  resetPassword: vi.fn(async () => ({ error: null })),
}));
```

and inside the `authClient: { ... }` mock object add:

```typescript
    requestPasswordReset: authMocks.requestPasswordReset,
    resetPassword: authMocks.resetPassword,
```

- [ ] **Step 2: Write the failing tests**

Still in `client/src/app/auth-pages.test.ts`, add a new describe block after the `verify-email page` block:

```typescript
describe('forgot-password page', () => {
  it('renders an email form and a back-to-login link', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ForgotPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('href="/login"');
  });

  it('requests a reset link addressed to /reset-password', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ForgotPage)));
    const input = container.querySelector('input');
    await act(async () => {
      if (input) setInputValue(input, 'user@example.test');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.requestPasswordReset).toHaveBeenCalledWith({
      email: 'user@example.test',
      redirectTo: '/reset-password',
    });
    expect(authMocks.requestPasswordReset).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('shows the enumeration-safe success state after submitting', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ForgotPage)));
    const input = container.querySelector('input');
    await act(async () => {
      if (input) setInputValue(input, 'user@example.test');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain(
      'If that account exists, a reset link is on its way.',
    );
    await act(async () => root.unmount());
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: FAIL — `./forgot-password/page` module not found.

- [ ] **Step 4: Implement**

Create `client/src/app/forgot-password/page.tsx`:

```typescript
'use client';

import Link from 'next/link';
import { useState } from 'react';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (error) {
      setError('Failed to send reset email. Try again in a minute.');
      return;
    }
    setSent(true);
  }

  return (
    <AuthLayout
      image={verificationArtwork}
      imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
      eyebrow="Password reset"
      title="Forgot your password?"
      description="Enter your email and we will send a reset link."
      quote="A clear signal. A private workspace."
    >
      <div className="auth-result auth-verification-panel">
        {sent ? (
          <>
            <p className="auth-verification-status">Reset link requested</p>
            <p className="auth-alert auth-alert-success" role="status">
              If that account exists, a reset link is on its way. It expires in
              one hour and works once.
            </p>
          </>
        ) : (
          <form className="auth-form" onSubmit={onSubmit}>
            <label className="studio-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
            <button className="auth-primary" type="submit" disabled={pending}>
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
            {error ? (
              <p className="auth-alert auth-alert-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
        <p className="auth-foot">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: PASS — all existing tests plus the 3 new ones (the page does not use `useSearchParams`, so no `Suspense` wrapper is needed; the other pages' tests keep passing).

- [ ] **Step 6: Commit**

```bash
git add client/src/app/forgot-password client/src/app/auth-pages.test.ts
git commit -m "feat(auth): add forgot-password page"
```

---

### Task 5: `/reset-password` page

**Files:**
- Create: `client/src/app/reset-password/page.tsx`
- Test: `client/src/app/auth-pages.test.ts`

**Interfaces:**
- Consumes: `AuthLayout`, `authClient.resetPassword` from `client/src/lib/auth-client.ts`; the email link lands here as `/reset-password?token=...` (valid) or `/reset-password?error=...` (invalid/expired, appended by Better Auth's callback redirect).
- Produces: route `GET /reset-password`; on submit calls `authClient.resetPassword({ newPassword, token })`; fixed invalid-link panel for missing token or `error` param.

- [ ] **Step 1: Write the failing tests**

In `client/src/app/auth-pages.test.ts`, add after the `forgot-password page` block:

```typescript
describe('reset-password page', () => {
  it('renders the new-password form when a token is present', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ResetPage));
    expect(markup).toContain('type="password"');
    expect(markup).toContain('New password');
    expect(markup).toContain('Confirm password');
  });

  it('shows a bounded invalid-link panel without a token and never renders raw error codes', async () => {
    navigationMocks.searchParams = new URLSearchParams(
      'error=INVALID_TOKEN&error_description=raw%20provider%20detail',
    );
    const ResetPage = (await import('./reset-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ResetPage));
    expect(markup).toContain(
      'This reset link is invalid or has expired. Request a new link and try again.',
    );
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).not.toContain('INVALID_TOKEN');
    expect(markup).not.toContain('raw provider detail');
  });

  it('resets the password through the token on matching inputs', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.resetPassword).toHaveBeenCalledWith({
      newPassword: 'password123',
      token: 'tok123',
    });
    expect(authMocks.resetPassword).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('blocks submit and stays bounded when the passwords do not match', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.resetPassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });

  it('shows the success panel after resetting', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Your password has been reset.');
    expect(container.textContent).toContain('sign in');
    await act(async () => root.unmount());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: FAIL — `./reset-password/page` module not found.

- [ ] **Step 3: Implement**

Create `client/src/app/reset-password/page.tsx`:

```typescript
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';

const INVALID_LINK_MESSAGE =
  'This reset link is invalid or has expired. Request a new link and try again.';

function ResetPasswordContent() {
  const search = useSearchParams();
  const token = search.get('token');
  const linkError = search.has('error');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({
      newPassword,
      token: token ?? '',
    });
    setPending(false);
    if (error) {
      setError(INVALID_LINK_MESSAGE);
      return;
    }
    setDone(true);
  }

  if (!token || linkError) {
    return (
      <div className="auth-result auth-verification-panel">
        <p className="auth-verification-status">Reset link problem</p>
        <p className="auth-alert auth-alert-error" role="alert">
          {INVALID_LINK_MESSAGE}
        </p>
        <p className="auth-foot">
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-result auth-verification-panel">
        <p className="auth-verification-status">Password updated</p>
        <p className="auth-description">Your password has been reset.</p>
        <p className="auth-alert auth-alert-success" role="status">
          Every signed-in session was signed out. Sign in with your new
          password.
        </p>
        <Link className="auth-primary" href="/login">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="studio-field">
        <span>New password</span>
        <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          autoComplete="new-password"
          minLength={8}
          placeholder="At least 8 characters"
        />
      </label>
      <label className="studio-field">
        <span>Confirm password</span>
        <input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          autoComplete="new-password"
          minLength={8}
          placeholder="Repeat your new password"
        />
      </label>
      <button className="auth-primary" type="submit" disabled={pending}>
        {pending ? 'Resetting…' : 'Reset password'}
      </button>
      {error ? (
        <p className="auth-alert auth-alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <AuthLayout
        image={verificationArtwork}
        imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
        eyebrow="Password reset"
        title="Choose a new password."
        description="Pick something strong. You will sign in again afterwards."
        quote="A clear signal. A private workspace."
      >
        <ResetPasswordContent />
      </AuthLayout>
    </Suspense>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: PASS — all previous tests plus the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/reset-password client/src/app/auth-pages.test.ts
git commit -m "feat(auth): add reset-password page"
```

---

### Task 6: Login "Forgot password?" link + signup confirm password

**Files:**
- Modify: `client/src/app/login/page.tsx:69-79`
- Modify: `client/src/app/signup/page.tsx:14-36,96-107`
- Test: `client/src/app/auth-pages.test.ts`

**Interfaces:**
- Consumes: `/forgot-password` route from Task 4.
- Produces: login form links to `/forgot-password`; signup form gains a confirm-password input; `authClient.signUp.email` is never called on mismatch.

- [ ] **Step 1: Write the failing tests**

In `client/src/app/auth-pages.test.ts`:

1. Inside `describe('login page')`, add:

```typescript
  it('links to the forgot-password page under the password field', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).toContain('Forgot password?');
  });
```

2. Update the existing signup test `sends successful email verification back to login` (around line 120): the form now has four inputs, so extend the input sequence with the confirm field:

```typescript
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      setInputValue(inputs[3], 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
```

(The `expect(authMocks.signUpEmail).toHaveBeenCalledWith(...)` body stays unchanged.)

3. Inside `describe('signup page')`, add two new tests:

```typescript
  it('renders a confirm password field that must match before sign-up', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(SignupPage)));
    const inputs = container.querySelectorAll('input');
    expect(inputs.length).toBe(4);
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      setInputValue(inputs[3], 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.signUpEmail).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });

  it('recovers from a mismatch once the confirm field is corrected', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(SignupPage)));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      setInputValue(inputs[3], 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      setInputValue(inputs[3], 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.signUpEmail).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: FAIL — login markup lacks the link; signup has 3 inputs, `inputs[3]` is undefined.

- [ ] **Step 3: Implement login link**

In `client/src/app/login/page.tsx`, insert between the closing `</label>` of the password field (line 79) and the submit `<button>` (line 80):

```tsx
          <p className="auth-foot">
            <Link href="/forgot-password">Forgot password?</Link>
          </p>
```

- [ ] **Step 4: Implement signup confirm field**

In `client/src/app/signup/page.tsx`:

1. Add state next to `password` (line 16):

```tsx
  const [confirmPassword, setConfirmPassword] = useState('');
```

2. Replace the body of `onSubmit` between `event.preventDefault();` and the `authClient.signUp.email` call with the mismatch guard:

```tsx
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: EMAIL_VERIFICATION_CALLBACK_URL,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed.');
      return;
    }
    setDone(true);
  }
```

3. Insert the confirm field between the password field's closing `</label>` (line 107) and the submit button (line 108):

```tsx
          <label className="studio-field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
              placeholder="Repeat your password"
            />
          </label>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run client/src/app/auth-pages.test.ts`
Expected: PASS — full file green.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/login/page.tsx client/src/app/signup/page.tsx client/src/app/auth-pages.test.ts
git commit -m "feat(auth): forgot-password link on login and confirm password on signup"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md` (auth section)
- Modify: `README.md` (auth routes mention)
- Modify: `docs/OPERATIONS.md` (auth troubleshooting note, if it lists auth routes)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: documentation matching the shipped behavior.

- [ ] **Step 1: Locate doc anchors**

Run: `npx vitest run client/src/app/auth-pages.test.ts 2>nul; echo ok` (sanity), then search for the auth sections:

Run: `git grep -n "verify-email" -- docs/ARCHITECTURE.md README.md docs/OPERATIONS.md`

Use each hit as the insertion anchor.

- [ ] **Step 2: Update docs**

In `docs/ARCHITECTURE.md`, wherever the public auth routes are enumerated (the text listing `/login`, `/signup`, `/verify-email`), extend the list with `/forgot-password` and `/reset-password`, and add one short paragraph:

```markdown
Password reset uses Better Auth's native flow: `/forgot-password` calls
`authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`;
the emailed link (`/api/auth/reset-password/:token`) redirects to
`/reset-password?token=...` for a single-use, one-hour token. A successful
reset revokes every session for the user (`revokeSessionsOnPasswordReset`).
Requests to `POST /request-password-reset` are rate-limited (5/min) by the
middleware `password-reset` scope. The reset mail reuses the Resend transport
(`RESEND_API_KEY` / `RESEND_FROM_EMAIL`, dev console fallback when unset).
Signup requires typing the password twice; the match check is client-side
only and never reaches `signUp.email` on mismatch.
```

In `README.md`, extend the auth mention (wherever sign-up/sign-in are described) with: "Forgot your password? `/forgot-password` emails a single-use reset link valid for one hour."

In `docs/OPERATIONS.md`, in the authentication walkthrough (around line 136), add one line: "Password reset: request a link at `/forgot-password`; the reset link is valid for one hour and can be used once. In dev the link is printed to the server console when `RESEND_API_KEY` is unset."

- [ ] **Step 3: Typecheck, lint, full tests**

Run from repo root:

```bash
npm run typecheck --workspace client
npm run lint --workspace client
npm run check
```

Expected: all pass. (`npm run check` covers storage/agent/client typecheck, client lint, full test suite with `NODE_OPTIONS=--max-old-space-size=8192` semantics per AGENTS.md — if it fails on heap, re-run with `NODE_OPTIONS=--max-old-space-size=8192 npm run check`.)

- [ ] **Step 4: Build**

Run: `npm run build`

Expected: passes. If the environment cannot reach the npm registry for the Mastra bundle step, document the external limitation and leave sources unchanged (per AGENTS.md completion checklist).

- [ ] **Step 5: Manual smoke (dev, optional but recommended)**

With Postgres up (`npm run dev:sh` or existing services): sign up, then visit `/login` → "Forgot password?" → enter the account email → observe `[auth] reset password email (dev console fallback): <url>` in the server console → open the URL → land on `/reset-password?token=...` → set mismatched passwords (blocked), then matching ones → "Your password has been reset." → sign in with the new password at `/login`; the old password no longer works.

- [ ] **Step 6: Whitespace check and commit**

```bash
git diff --check
git add docs/ARCHITECTURE.md README.md docs/OPERATIONS.md
git commit -m "docs: password reset flow and signup confirm password"
```

---

## Self-Review Checklist (already applied)

- Spec coverage: Task 1 (reset sender), Task 2 (options wiring + revocation + migrate stub), Task 3 (public paths + rate limit), Task 4/5 (both pages + enumeration-safe copy), Task 6 (login link + confirm field), Task 7 (docs + `npm run check` + `npm run build`). All spec sections mapped.
- No placeholders; every code step shows complete code.
- Type consistency: `sendResetPasswordEmail({ to, url })` used identically in Tasks 1-2; `requestPasswordReset` / `resetPassword` client names verified against better-auth 1.6.25; mock names in Tasks 4-6 match the hoisted `authMocks` additions.
- Existing-test fallout handled: `auth.test.ts` call sites (Task 2), signup input indices (Task 6).
