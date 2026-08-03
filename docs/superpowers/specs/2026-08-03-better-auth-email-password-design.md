# Better Auth Email/Password Authentication Design

## Status

Approved for implementation planning on 2026-08-03.

This specification adds Better Auth plain email/password authentication with
mandatory email verification to the `client` workspace, replacing the
temporary `CHEKKU_LOCAL_USER_ID` identity seam. It does not introduce
per-user stored-agent ownership (Phase 2), password reset (Phase 2), SSO/OIDC,
or agent-server-side session validation.

## Goal

Replace the development-only `CHEKKU_LOCAL_USER_ID` seam with real
authentication so that:

- Users sign up and sign in with email and password.
- Every account must verify its email address before it can sign in.
- Conversations (Memory threads) are isolated per user.
- All application routes are gated behind a session except the auth pages.
- Code-defined agents remain shared globally; the agent server is unchanged.

The existing architecture invariant from `AGENTS.md` controls this work:
"`CHEKKU_LOCAL_USER_ID` is a temporary local identity seam. Replace it with
OIDC later without changing thread-ownership semantics." Better Auth
email/password is the concrete replacement; thread-ownership semantics
(`resourceId`-keyed Memory) stay identical, only the value source changes from
an env var to a verified session.

## Locked Decisions

1. **User model:** Open multi-user registration. Anyone can sign up with a
   valid email after verification.
2. **Conversations:** Isolated per user. `resourceId = session.user.id`.
3. **Agents:**
   - Code-defined agents (`pm-agent`, `qa-web-agent`, `qa-android-agent`,
     `social-media-content-writer`, `social-media-supervisor-agent`,
     `social-media-strategist-agent`, `visual-content-agent`) are shared
     globally. Every authenticated user sees and uses them.
   - Stored agents remain a **global pool** in v1. Every user currently sees
     every stored agent. Per-user stored-agent ownership is deferred to
     Phase 2 (see Out of Scope).
4. **Route protection:** Full gate. Only `/login`, `/signup`, `/verify-email`,
   `/api/auth/*`, and static assets are public. Everything else requires a
   session. Root `/` redirects to `/login` (unauth) or `/agents` (auth).
5. **Verification email transport:** Resend when `RESEND_API_KEY` is set
   (reuses the existing server-only Resend integration via raw HTTP `fetch`;
   no `resend` npm package is introduced). Console fallback in dev: when
   `RESEND_API_KEY` is unset, the verification URL is logged to the server
   console so it can be opened manually. (The `sendVerificationEmail`
   callback's return value is not the Better Auth signup API response, so the
   URL is surfaced via logs only, not injected into the HTTP response.)
6. **Verification strictness:** Strict. `requireEmailVerification: true` plus
   `sendOnSignIn: true`. Unverified users cannot obtain a session.
7. **Existing data migration:** Fresh start. Data persisted under
   `resourceId = 'local-user'` (Memory threads, Garage PM reports, social
   posts, stored-agent namespace) is ignored by new users because the
   `resourceId` will never match a real `user.id`. No rewrite or deletion is
   performed.
8. **Auth placement:** `client` workspace only. The agent server never imports
   Better Auth and never reads `chekku_auth`. The client remains the single
   identity seam; the agent server continues to trust the resolved
   `resourceId` passed through the proxy, gated by the existing
   `AGENT_SERVICE_TOKEN`.

## Out Of Scope (Phase 2 And Later)

- **Per-user stored-agent ownership.** Requires an agent-workspace change:
  add an `ownerId` to stored-agent records in the `@mastra/editor` layer and
  filter `list`/`get`/`update`/`delete` by owner, plus ownership checks at the
  `/api/agent/*` proxy. The current `client/src/lib/stored-agents.ts`
  `listStoredAgents()` call has no user filter and the Mastra stored-agent
  system has no tenant dimension, so client-only filtering would not be real
  isolation. Deferred.
- **Password reset / forgot-password flow.** The `sendResetPassword` config
  slot will be wired but no reset pages ship in v1.
- **SSO / OIDC / social providers.**
- **Agent-server-side session validation.** The agent server stays behind
  `AGENT_SERVICE_TOKEN`; defense-in-depth session validation at the agent
  boundary is a later option if the agent server ever exposes its own
  user-facing surface.
- **Robust distributed rate limiting.** v1 ships an in-memory IP token-bucket
  on signup and resend only. A reverse-proxy or Redis-backed limiter can
  replace it later.
- **Migration tooling for existing `local-user` data.**

## Architecture And Data Flow

```text
Browser ──cookie──> Next.js (client workspace)
                      |
                      +- /api/auth/[...all]  -> Better Auth handler
                      |                         (sign-up, sign-in, sign-out,
                      |                          verify-email, send-verification-email,
                      |                          session)
                      +- middleware.ts        -> gates all routes except auth pages
                      |                         and /api/auth/*
                      +- getUserId()          -> auth.api.getSession({ headers })
                      |                         -> session.user.id | null
                      |
                      +- /api/agent/*,
                         /api/storage/*        -> proxy -> Mastra (agent server)
                                                   ^ resourceId = session.user.id
                                                   ^ AGENT_SERVICE_TOKEN (unchanged)
```

### Identity resolution

`client/src/server/auth.ts:getUserId()` is the single rewrite point. It
currently returns `process.env.CHEKKU_LOCAL_USER_ID ?? 'local-user'`. The new
implementation reads the Better Auth session cookie server-side:

```ts
export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}
```

Middleware guarantees a session on every protected route, so callers on
protected routes receive a non-null id. `getDownstreamToken()` is unchanged.

All ~15 inline `process.env.CHEKKU_LOCAL_USER_ID || 'local-user'` call sites
in `client/src/app/**` switch to `await getUserId()`. Server components are
already async. The Memory `resourceId`, PM report ownership, and social-post
ownership all derive from this value, so ownership semantics are unchanged;
only the value source changes from an env var to a verified session.

### Agent server boundary (unchanged)

Mastra still receives `resourceId` from the client proxy. The value changes
from `'local-user'` to a real `session.user.id`. The hop remains gated by
`AGENT_SERVICE_TOKEN`. The agent server never imports Better Auth and never
touches the `chekku_auth` database.

### Databases

One Postgres instance, two databases (already provisioned by
`scripts/postgres/init-databases.sh`):

- `chekku_agent` - Mastra storage (Memory threads, stored agents). Unchanged.
- `chekku_auth` - Better Auth tables (`user`, `account`, `session`,
  `verification`). Better Auth owns its schema. A separate pg pool in
  `client/src/lib/auth.ts` connects to `chekku_auth` via `AUTH_DATABASE_URL`.
  It does not share a connection with Mastra.

## Components And Files

All changes are in the `client` workspace. The `agent` and `storage`
workspaces are untouched.

### New files

| File | Role |
|------|------|
| `client/src/lib/auth.ts` | `betterAuth({ database, emailAndPassword, emailVerification, secret, baseURL })`. Exports `auth`. Server-only. |
| `client/src/lib/auth-client.ts` | `createAuthClient()` (react). Exports `authClient` and the `useSession` hook. |
| `client/src/app/api/auth/[...all]/route.ts` | `export const { GET, POST } = toNextJsHandler(auth)`. |
| `client/src/middleware.ts` | Protects all routes except `/login`, `/signup`, `/verify-email`, `/api/auth/*`, `/_next/*`, and static. Unauth on protected -> `/login`. Auth on auth pages -> `/agents`. |
| `client/src/server/email.ts` | `sendVerificationEmail({ user, url })`. Raw `fetch` to Resend when `RESEND_API_KEY` is set; else `console.log(url)` and return the URL for dev. Server-only. No `resend` package. |
| `client/src/app/login/page.tsx` | Email/password form (client component using `authClient.signIn.email`). Error display. Link to `/signup`. |
| `client/src/app/signup/page.tsx` | Email/password form. On success shows "check your email" state. Link to `/login`. |
| `client/src/app/verify-email/page.tsx` | "Check your email" state with a resend button (`authClient.emailVerification.sendVerificationEmail`). Also renders the verified-success state after the email callback redirects here. |

### Rewritten files

- `client/src/server/auth.ts` - `getUserId()` reads the Better Auth session.
  `getDownstreamToken()` unchanged.
- `client/src/app/**` (~15 pages) - replace
  `const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user'` with
  `const resourceId = await getUserId()`. Pages: `chat`, `agents`, `agents/new`,
  `agents/[id]/edit`, `reports`, `reports/weekly`, `reports/[reportId]`,
  `reports/competitive`, `reports/competitive/[analysisId]`,
  `reports/competitive/[analysisId]/slides`, `social-posts`,
  `social-posts/[postId]`.

### Dependency changes (`client/package.json`)

Added:

- `better-auth`
- `pg`
- `@types/pg` (devDependency)

Not added: `resend` (raw `fetch` matches the existing email pattern).

### Stored agents

`client/src/lib/stored-agents.ts` is unchanged in v1. The catalog continues to
list all stored agents globally. A code comment and an AGENTS.md note record
that per-user ownership is Phase 2.

## Email Verification Flow

### Configuration

```ts
betterAuth({
  database: new Pool({ connectionString: process.env.AUTH_DATABASE_URL }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // sendResetPassword wired but reset pages ship in Phase 2
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, url });
    },
    sendOnSignIn: true,
  },
});
```

### Flow

1. User submits `/signup`. Better Auth creates the user (unverified) and
   invokes `sendVerificationEmail({ user, url })`.
2. `sendVerificationEmail` (in `client/src/server/email.ts`):
   - If `RESEND_API_KEY` is set, POSTs to Resend with `RESEND_FROM_EMAIL` as
     the sender, the user's email as recipient, and `url` in the body.
   - If `RESEND_API_KEY` is unset, logs `url` to the server console so the
     developer can open it manually. The URL is not injected into the signup
     HTTP response (the callback return value is not the API response).
3. The email link points at `/api/auth/verify-email?token=...`, the Better
   Auth callback. On success Better Auth sets `emailVerified = true` and
   redirects to `/verify-email?status=verified`.
4. `/verify-email` renders "your email is verified, you can sign in" and links
   to `/login`.
5. If an unverified user attempts to sign in, `requireEmailVerification`
   blocks the attempt and `sendOnSignIn: true` auto-resends the verification
   email. The user still has no session, so middleware keeps them off every
   protected route.
6. The resend button on `/verify-email` POSTs to
   `/api/auth/send-verification-email`. Better Auth's handler is
   enumeration-resistant: unauthenticated requests enforce a 500ms
   constant-time floor and always return `{ status: true }`, whether or not
   the email exists or is already verified.

### Token expiry

Default 24 hours, configurable via `emailVerification.expiresIn`.

## Security

### Secret management

All of the following are server-only and must never appear in client bundles,
errors, or logs (AGENTS.md secrets convention):

- `BETTER_AUTH_SECRET`
- `AUTH_DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `AGENT_SERVICE_TOKEN`

No browser-exposed keys are introduced (AGENTS.md model-and-secrets invariant).

### Cookies

Better Auth sets httpOnly cookies. In production (HTTPS) cookies are `secure`
with `sameSite: 'lax'`. Better Auth's built-in CSRF protection covers its own
endpoints.

### Rate limiting (v1-minimal)

Better Auth has no built-in rate limiting on signup or verification-email
resend. v1 adds a small in-memory IP token-bucket applied in `middleware.ts`
(or a thin wrapper around the signup and resend handlers) covering:

- `POST /api/auth/sign-up/username-password` (or the configured sign-up path)
- `POST /api/auth/send-verification-email`

No new dependency. The limiter is best-effort and single-process; a reverse
proxy or Redis-backed limiter can replace it later. Rate-limit responses use
HTTP 429 with a fixed message and no diagnostics.

### Enumeration resistance

Rely on Better Auth defaults and document them so they do not regress:

- Sign-up with an existing email returns a success-shaped response.
- `send-verification-email` enforces a 500ms constant-time floor and always
  returns `{ status: true }`.

### Error handling

All auth errors map to fixed, actionable user-facing messages. No credentials,
secrets, endpoints, request IDs, or stack traces are exposed in responses or
logs (AGENTS.md convention).

### Removal of the old seam

`CHEKKU_LOCAL_USER_ID` is removed from `client/.env.example`, the root
`.env.example`, `agent/.env.example`, `agent/src/config/env.ts`, `README.md`,
`docs/OPERATIONS.md`, and `docs/ARCHITECTURE.md` references. The variable is
no longer read anywhere.

## Environment Variables

### New (client workspace)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `BETTER_AUTH_SECRET` | Yes | - | Session signing secret. |
| `BETTER_AUTH_URL` | Yes | - | App base URL (e.g. `http://localhost:3000`). Used in verification email links. |
| `AUTH_DATABASE_URL` | Yes | - | Postgres connection string to the `chekku_auth` database. |

### Reused (already server-only)

- `RESEND_API_KEY` - Resend transport for verification email.
- `RESEND_FROM_EMAIL` - Verification email sender address.
- `AGENT_SERVICE_TOKEN` - unchanged client -> agent-server hop credential.

### Removed

- `CHEKKU_LOCAL_USER_ID` - no longer read. Removed from all env examples and
  docs.

## AGENTS.md And Documentation Updates

The implementation must update:

- `AGENTS.md` "Client proxy and identity" section - replace the
  `CHEKKU_LOCAL_USER_ID` seam description with the Better Auth session
  resolution; note that `resourceId` semantics are unchanged; add the new
  env vars; record the Phase 2 stored-agent-ownership deferral.
- `README.md` environment tables - remove `CHEKKU_LOCAL_USER_ID`, add
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`.
- `docs/OPERATIONS.md` - remove the `CHEKKU_LOCAL_USER_ID` references and the
  "replace `CHEKKU_LOCAL_USER_ID` with real authentication" cleanup item;
  add Better Auth setup, Resend verification-email notes, and the dev console
  fallback.
- `docs/ARCHITECTURE.md` - update the identity-seam description.
- `client/.env.example`, root `.env.example`, `agent/.env.example`,
  `agent/src/config/env.ts` - remove `CHEKKU_LOCAL_USER_ID`.

## Testing

Tests use Vitest, alongside the relevant module or in `__tests__` folders
(AGENTS.md testing rules). No second test runner.

- `client/src/lib/auth.ts` - `sendVerificationEmail` Resend path (mock global
  `fetch`, assert request shape and `RESEND_FROM_EMAIL` sender) and console
  fallback when `RESEND_API_KEY` is unset.
- `client/src/server/auth.ts` - `getUserId()` returns `session.user.id` when
  a session is present and `null` when absent (mock `auth.api.getSession` and
  `headers()`).
- `client/src/middleware.ts` - unauth on a protected route redirects to
  `/login`; auth on `/login` redirects to `/agents`; `/api/auth/*`, static,
  and the public auth pages pass through.
- Rate limiter - allows requests under the cap, returns 429 over the cap,
  no diagnostics leaked.
- Email transport module - Resend fetch shape, console fallback, fixed error
  messages on transport failure.
- Regression - `resourceId` now sourced from the session (extend the existing
  thread-ownership tests); stored-agent list still global (Phase 2 marker).

## Completion Checklist

Before claiming completion:

- [ ] The change follows the active architecture; the agent server is
  unchanged and never imports Better Auth.
- [ ] No secret or local state is added to client bundles.
- [ ] `CHEKKU_LOCAL_USER_ID` is removed everywhere.
- [ ] Affected tests were added or updated.
- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] `README.md`, `AGENTS.md`, `docs/OPERATIONS.md`, and `docs/ARCHITECTURE.md`
      match the new env vars and the removed seam.

## Open Questions For Implementation Planning

- Exact Better Auth sign-up/sign-in endpoint paths after configuration (the
  library exposes them under `/api/auth/*`; the plan should pin the exact
  routes used by `authClient`).
- Whether the in-memory rate limiter lives in `middleware.ts` or a thin
  handler wrapper (the plan should pick one and keep it unit-testable).
- Signup form password-strength policy (Better Auth default min/max length is
  acceptable for v1; the plan should confirm and document).
