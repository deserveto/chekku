# Password Reset and Signup Confirm-Password Design

## Status

Approved for implementation planning on 2026-08-16.

This specification adds the password-reset flow ("Forgot password") deferred to
Phase 2 by `2026-08-03-better-auth-email-password-design.md`, plus a
confirm-password field on signup. It uses Better Auth's native
`requestPasswordReset`/`resetPassword` APIs (verified against installed
better-auth 1.6.25: client methods are inferred from the
`/request-password-reset` and `/reset-password` endpoints; the legacy
`forgetPassword` name does not exist in this version). It does not add OTP
codes, security questions, password change for signed-in users, or any
agent-server change.

## Goals

1. A user who forgot their password can request a reset link by email, then set
   a new password by opening that link.
2. Signup requires typing the password twice; mismatched entries never reach
   `signUp.email`.
3. No new environment variables, no database migration, no user enumeration.

## Locked Decisions

1. **Reset mechanism:** Better Auth native email reset link
   (`POST /request-password-reset` → emailed URL →
   `GET /api/auth/reset-password/:token?callbackURL=/reset-password` →
   browser lands on `/reset-password?token=...`). Token is single-use, expires
   after 1 hour (Better Auth defaults), stored in the existing `verification`
   table. No custom token code.
2. **UI shape:** Two dedicated public pages mirroring the existing
   `/verify-email` page pattern (`AuthLayout` split composition, artwork,
   bounded alerts). No modal.
3. **Session revocation:** `revokeSessionsOnPasswordReset: true` — a successful
   reset deletes all of that user's sessions. A stolen-password victim who
   resets signs every attacker session out.
4. **No user enumeration:** the request endpoint always answers generic
   success (Better Auth native behavior); both pages use fixed bounded error
   text ("If that account exists, a reset link is on its way." / fixed
   invalid-token message). Reset emails and errors never confirm whether an
   account exists.
5. **Rate limiting:** middleware gains one scope for
   `POST /request-password-reset` (same 5-per-minute bucket family as
   signup/signin/resend). `POST /reset-password` gets no scope: the token is
   single-use, unguessable, and rate limiting it would only lock out the
   legitimate recipient of a valid link.
6. **Confirm password is client-side only.** It is a UX guard against typos,
   not a security boundary; the server password policy is unchanged
   (Better Auth min length 8).

## Server Changes

### `client/src/lib/auth-options.ts`

- Add required `sendResetPassword` argument to `buildAuthOptions`
  (`(args: { user: { email: string }; url: string }) => Promise<void>`),
  following the same required-injection pattern as `sendVerificationEmail`
  (a no-op default would silently disable reset delivery).
- Wire it into `emailAndPassword.sendResetPassword`.
- Set `emailAndPassword.revokeSessionsOnPasswordReset: true`.

### `client/src/server/email.ts`

- Add `sendResetPasswordEmail({ to, url })` mirroring
  `sendVerificationEmail`: Resend `POST /emails` when `RESEND_API_KEY` is set
  (subject "Reset your Chekku password"), dev console fallback logging the URL
  when unset, fixed sanitized errors (`Failed to send reset password email.`)
  that never leak the API response, headers, or recipient beyond what the
  caller already knows. Cancel the response body on non-OK exactly like the
  verification sender.

### `client/src/lib/auth.ts`

- Compose: pass `server/email.ts`'s `sendResetPasswordEmail` into
  `buildAuthOptions` as `sendResetPassword` (`({ user, url }) =>
  sendResetPasswordEmail({ to: user.email, url })`).

## Client Changes

### `/forgot-password` (new `client/src/app/forgot-password/page.tsx`)

- `AuthLayout` page, `Suspense`-wrapped content component (same shape as
  login/verify-email).
- Single email field → `authClient.requestPasswordReset({ email, redirectTo:
  '/reset-password' })`.
- After submit, success state: "If that account exists, a reset link is on its
  way." plus a back-to-login link. Server errors render as bounded
  `auth-alert-error` text.

### `/reset-password` (new `client/src/app/reset-password/page.tsx`)

- `Suspense`-wrapped; reads `token` from search params.
- Missing token, or arrival via Better Auth's invalid-token redirect
  (`error` query param, mirroring the login `verified=1`/`error` pattern):
  bounded error panel — "This reset link is invalid or has expired. Request a
  new link and try again." — with a link to `/forgot-password`. Raw error codes
  and provider details are never rendered.
- Valid-token state: New password + Confirm password fields (both
  `minLength={8}`, `autoComplete="new-password"`), client-side match check with
  bounded inline error, submit → `authClient.resetPassword({ newPassword,
  token })`.
- Success state: "Your password has been reset." panel with a link to
  `/login` (the user is signed out; revocation deleted sessions).

### `/login` (`client/src/app/login/page.tsx`)

- Add "Forgot password?" link (right-aligned under the password field, above
  submit) → `/forgot-password`.

### `/signup` (`client/src/app/signup/page.tsx`)

- Add Confirm password field after Password (min 8, `autoComplete="new-password"`).
- On submit: if `password !== confirmPassword`, set bounded inline error
  ("Passwords do not match.") and do not call `authClient.signUp.email`.
- The post-signup verification panel is unchanged.

### `client/src/server/auth-rate-limit.ts`

- Add `/forgot-password` and `/reset-password` to `PUBLIC_PATHS` (signed-out
  access; signed-in users bounce to `/agents` like the other auth pages).

### `client/src/middleware.ts`

- Add `POST` ends-with guard for `/request-password-reset` using a new
  `password-reset` scope via `consumeRateLimit` (default 5/min cap),
  returning the same 429 + `retry-after` shape.

## Data Flow

1. Browser: `/forgot-password` form → `authClient.requestPasswordReset` →
   `POST /api/auth/request-password-reset` (middleware rate limit) → Better
   Auth builds `${baseURL}/reset-password/${token}?callbackURL=/reset-password`
   → `sendResetPassword` hook → `sendResetPasswordEmail` (Resend or console).
2. Email link click → `GET /api/auth/reset-password/:token?callbackURL=/reset-password`
   → token valid: redirect `/reset-password?token=...`; invalid/expired:
   redirect with `error` param.
3. `/reset-password` form → `authClient.resetPassword` →
   `POST /api/auth/reset-password` → Better Auth consumes the single-use token,
   hashes the new password, deletes the user's sessions (revocation), calls
   `onPasswordReset` (unset — no-op) → success panel → `/login`.

## Error Handling

- Fixed, bounded, actionable messages everywhere; no provider bodies, no
  tokens, no raw error codes rendered. Missing/invalid/expired token on
  `/reset-password` collapses to one message + re-request link.
- Email delivery failure of the reset mail surfaces as the endpoint's generic
  success (enumeration guard) while the sender throws its fixed error
  server-side, same trade-off the verification sender already accepts.

## Testing

Extend `client/src/app/auth-pages.test.ts` (jsdom) and adjacent suites:

- Forgot-password page renders, calls `authClient.requestPasswordReset` with
  `redirectTo: '/reset-password'`, shows generic success state.
- Reset-password page: renders token form when `token` present; bounded
  invalid/missing-token panel (no raw codes); calls
  `authClient.resetPassword({ newPassword, token })` on match; blocks submit on
  mismatch.
- Login page renders `href="/forgot-password"`.
- Signup: mismatch never calls `signUp.email` (and clears when fixed); match
  calls it exactly as before; confirm field rendered.
- `buildAuthOptions` unit test: `emailAndPassword.sendResetPassword` invokes
  the injected sender and `revokeSessionsOnPasswordReset` is `true`
  (`auth-options` stays `server-only`-free, so testable directly).
- `email.test.ts`: reset sender mirrors verification sender coverage (console
  fallback, missing `RESEND_FROM_EMAIL`, non-OK response).
- Middleware/`resolveAuthRedirect`: `/forgot-password` and `/reset-password`
  public for signed-out, bounce signed-in; `/request-password-reset` POST
  rate-limited.

## Documentation

- `docs/ARCHITECTURE.md` and `README.md`: add the two public auth routes and
  the reset flow summary. No env var changes; note reuse of
  `RESEND_API_KEY`/`RESEND_FROM_EMAIL`.

## Out of Scope

- Signed-in password change UI.
- OTP/code-based reset, security questions.
- Custom token expiry configuration (`resetPasswordTokenExpiresIn` stays
  default 1 hour).
- Agent server changes; per-user stored-agent ownership.
