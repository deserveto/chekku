# Auth Environment & Setup Production-Readiness Design

## Status

Approved for implementation planning on 2026-08-03.

This specification makes the Better Auth environment production-grade by wiring
`scripts/setup-env.sh` to generate real client auth values, adding a dedicated
migration command, and updating the env examples and operational docs. It does
not introduce production deployment artifacts (Dockerfiles, prod compose, CI,
reverse-proxy/HTTPS setup) — those are a separate later spec.

## Problem

After `npm run setup`, the client auth environment is non-functional:

- `client/.env.local` is copied from `client/.env.example`, which ships
  `BETTER_AUTH_SECRET=` (empty) and
  `AUTH_DATABASE_URL=postgresql://chekku:chekku@localhost:5432/chekku_auth`
  (hardcoded password `chekku`). The real Postgres password is the random token
  generated into `storage/.env.local`, so the client cannot connect to
  `chekku_auth`, and Better Auth has no session secret.
- `setup-env.sh` generates random secrets for Garage, SearXNG, and the agent,
  but generates nothing for Better Auth and never wires `AUTH_DATABASE_URL` to
  the generated `POSTGRES_PASSWORD`.
- `client/.env.example` omits `RESEND_API_KEY` / `RESEND_FROM_EMAIL`, and
  `setup-env.sh` only prompts/writes Resend into `agent/.env`. The client's
  verification-email transport therefore never sees Resend credentials, so
  real verification email delivery is impossible without manual edits.
- The root `.env.example` (the combined deployment reference) lists no auth
  vars, and `docs/OPERATIONS.md` still shows placeholder values.

## Scope

In scope (Gaps 1–5, 8 from the identification):

- Extend `scripts/setup-env.sh` with a `render_client_env` step that generates
  `BETTER_AUTH_SECRET`, wires `AUTH_DATABASE_URL` to the generated
  `POSTGRES_PASSWORD`, defaults `BETTER_AUTH_URL`, and dual-writes the prompted
  Resend values into `client/.env.local`.
- Add a dedicated `npm run db:migrate` script that runs the Better Auth schema
  migration idempotently against `AUTH_DATABASE_URL`.
- Update `client/.env.example`, the root `.env.example`, `docs/OPERATIONS.md`,
  and `README.md`.

Out of scope (separate later spec):

- Production deployment artifacts: Dockerfiles for client/agent, a prod compose
  override, CI, reverse-proxy/HTTPS termination, automated deploy-time
  migration hooks.
- Per-user stored-agent ownership, password reset, SSO/OIDC, agent-server-side
  session validation, distributed rate limiting (all still Phase 2 from the
  auth spec).

## Locked Decisions

1. **`setup-env.sh` is the dev/bootstrap tool.** It writes gitignored local
   files (`client/.env.local`, `agent/.env`, `agent/.env.development`,
   `storage/.env.local`, `searxng/.env.local`). Production does not commit
   these.
2. **Production injects the same variables via the hosting platform's secret
   or env configuration** — never via a committed file. The root `.env.example`
   is the canonical reference of which variables exist.
3. **`BETTER_AUTH_SECRET` is always generated, never prompted.** A user cannot
   hand-type a 32+ char secret; the script generates
   `crypto.randomBytes(32).toString('base64url')` and preserves it on re-run.
4. **`AUTH_DATABASE_URL` is built from the generated `POSTGRES_PASSWORD`** —
   same password as the agent's `DATABASE_URL`, pointing at `chekku_auth`. A
   non-empty user override is preserved (remote/staging Postgres), mirroring
   the agent-side `DATABASE_URL` override pattern.
5. **Resend is prompted once and dual-written** to `agent/.env` and
   `client/.env.local`. Empty values keep the dev console fallback.
6. **Migration is its own idempotent command (`npm run db:migrate`)**, not
   folded into `setup-env.sh` (which must not depend on a running database).
   `setup-env.sh` prints it as the next step.
7. **No new dependencies.** Reuses `node:crypto`, `dotenv`, and the existing
   `@better-auth/cli` (already used manually today).

## Architecture And Data Flow

```text
npm run setup
  -> scripts/setup-env.sh
       source storage/.env.local  (POSTGRES_PASSWORD already generated)
       render_agent_dev_env       (existing: DATABASE_URL from POSTGRES_PASSWORD)
       render_client_env          (NEW)
         BETTER_AUTH_SECRET  = pick(existing, randomBytes(32).base64url)
         AUTH_DATABASE_URL   = pick(existing user override,
                                    postgresql://chekku:${POSTGRES_PASSWORD}@127.0.0.1:5432/chekku_auth)
         BETTER_AUTH_URL     = pick(existing, http://localhost:3000)
         RESEND_API_KEY      = prompted (dual-written to agent/.env too)
         RESEND_FROM_EMAIL   = prompted (dual-written to agent/.env too)
       print_summary              (updated: lists client/.env.local + next step)

npm run db:migrate
  -> scripts/db-migrate.sh
       load AUTH_DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL from client/.env.local
       cd client && npx @better-auth/cli migrate
```

`scripts/dev.sh` (the launcher) needs no change: it sources service env and
unsets secrets per pane; Next.js reads `client/.env.local` itself when
`npm run dev:client` starts.

## Components And Files

### `scripts/setup-env.sh` (modify)

Add `render_client_env`, placed after `render_agent_dev_env`. It must:

- Run the existing `sync_env_from_example` for `client/.env.local` first (so any
  new example keys are present), then overwrite the auth block.
- Read the existing `client/.env.local` with `dotenv.parse`, apply the
  `pick(existing, fallback)` idiom for `BETTER_AUTH_SECRET`,
  `AUTH_DATABASE_URL`, `BETTER_AUTH_URL`, `RESEND_API_KEY`,
  `RESEND_FROM_EMAIL`.
- Source `POSTGRES_PASSWORD` from `storage/.env.local` (already sourced earlier
  in the script for `render_agent_dev_env`).
- Write atomically (tmp file + `mv`), mode 0600, no CR/LF in values, safe
  quoting via the existing `serialize`/candidate pattern used for
  `agent/.env.development`.
- Leak guard: `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD` must never appear in
  setup stdout (extend the existing secret-leak discipline).

Extend `run_prompts` so the `RESEND_API_KEY` / `RESEND_FROM_EMAIL` values it
collects are also written to `client/.env.local` (dual-write). The agent-side
prompt behavior is unchanged.

Update `print_summary` to:

- Add `client/.env.local` to "Files generated/updated".
- Print a "Next step" line: `docker compose up -d postgres && npm run db:migrate`.

### `scripts/db-migrate.sh` (new)

`#!/usr/bin/env bash`, `set -euo pipefail`. Behavior:

- Resolve repo root; require `client/.env.local` exists.
- Load `AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` from
  `client/.env.local` via a small `node` + `dotenv` reader (mirroring the
  pattern used elsewhere in the repo's scripts).
- If `AUTH_DATABASE_URL` is empty → fail with a fixed actionable message
  ("Run npm run setup first." ) and exit 1. No provider call.
- Export the three vars into the environment, `cd client`, run
  `npx @better-auth/cli migrate`.
- Surface a fixed actionable error if the CLI is missing or the database is
  unreachable; never print `AUTH_DATABASE_URL` (contains the password) or
  `BETTER_AUTH_SECRET`.

### `package.json` (modify, root)

Add `"db:migrate": "bash ./scripts/db-migrate.sh"` to `scripts`.

### `client/.env.example` (modify)

Append:

```
# Verification email transport (client-side). Optional in dev (server console
# fallback when RESEND_API_KEY is unset); required for real email delivery.
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

Keep `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `AUTH_DATABASE_URL` as
placeholders — they are the sync source; `render_client_env` overwrites them
with generated/wired values.

### Root `.env.example` (modify)

Add a Client / Auth block alongside the existing Client block:

```
# Client (Next.js) + Better Auth
AGENT_URL=http://localhost:4111
NEXT_PUBLIC_APP_URL=http://localhost:3000
AGENT_SERVICE_TOKEN=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_URL=postgresql://chekku:postgres@localhost:5432/chekku_auth
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

### `docs/OPERATIONS.md` (modify)

Rewrite the Authentication subsection to:

- Show that `npm run setup` generates `BETTER_AUTH_SECRET` and wires
  `AUTH_DATABASE_URL` to the generated `POSTGRES_PASSWORD` in
  `client/.env.local` (no manual secret typing).
- Add `npm run db:migrate` as the step that applies the Better Auth schema.
- Add a Production note: inject the same variables via the hosting platform;
  set `BETTER_AUTH_URL` to the real **HTTPS** origin (required for secure
  session cookies); run `npm run db:migrate` as a deploy release step.

### `README.md` (modify)

Update the client environment table to include `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `AUTH_DATABASE_URL`, and the RESEND vars, and point the
setup instructions to `npm run setup` followed by `npm run db:migrate`.

## Generation Semantics (preserve-existing contract)

`render_client_env` is idempotent and non-destructive:

- Values the user has already set (non-empty) are preserved across re-runs.
- Only empty/missing auth values are generated or wired.
- The rest of `client/.env.local` (comments, `AGENT_URL`,
  `NEXT_PUBLIC_APP_URL`, `AGENT_SERVICE_TOKEN`, anything the user added) is
  preserved byte-for-byte except for the auth lines being updated in place.
- File mode stays 0600.

This matches the established `pick(existing, fallback)` discipline already used
by `generate_storage_env` and the agent `DATABASE_URL` override.

## Security

- Generated/wired values live only in gitignored files (`client/.env.local`,
  `storage/.env.local`) or the host's secret config in prod. Never committed.
- `setup-env.sh` and `db-migrate.sh` never print `BETTER_AUTH_SECRET`,
  `POSTGRES_PASSWORD`, or the password embedded in `AUTH_DATABASE_URL`. The
  existing stdout secret-leak guard is extended to cover the auth secret.
- `db-migrate.sh` fails closed when `AUTH_DATABASE_URL` is empty — no provider
  call, no partial state.
- `BETTER_AUTH_URL` must be an HTTPS origin in production so Better Auth issues
  `secure` cookies; documented in OPERATIONS.

## Testing

Extend `scripts/dev.test.ts` (the existing `setup-env.sh` harness). New cases:

- `render_client_env` writes a non-empty `BETTER_AUTH_SECRET` of at least 32
  characters into `client/.env.local`.
- `AUTH_DATABASE_URL` in `client/.env.local` matches the generated
  `POSTGRES_PASSWORD` and points at `chekku_auth` (not `chekku_agent`).
- Re-running setup preserves a user-set `BETTER_AUTH_SECRET` and a user-set
  `AUTH_DATABASE_URL` override.
- Prompted `RESEND_API_KEY` / `RESEND_FROM_EMAIL` values are written to both
  `agent/.env` and `client/.env.local`.
- Secret-leak guard: `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD` do not appear
  in `setup-env.sh` stdout.
- `db-migrate.sh` exits non-zero with a fixed message when
  `AUTH_DATABASE_URL` is empty and never invokes the Better Auth CLI. The
  happy-path migration (which needs live Postgres) is documented as a manual
  verification step, matching how the existing migration was validated.

`npm run check` and `npm run build` must pass.

## Completion Checklist

- [ ] `setup-env.sh` generates `BETTER_AUTH_SECRET` + wires `AUTH_DATABASE_URL`
      into `client/.env.local`; RESEND dual-written; summary updated.
- [ ] `npm run db:migrate` exists and fails closed on missing `AUTH_DATABASE_URL`.
- [ ] `client/.env.example`, root `.env.example`, `docs/OPERATIONS.md`,
      `README.md` updated.
- [ ] `scripts/dev.test.ts` cases added; `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] No secret or local state added to commits.

## Implementation Invariants

- **Ordering inside `setup-env.sh`** is fixed: `sync_env_from_example` (client)
  → `run_prompts` (collects Resend) → `render_agent_dev_env` →
  `render_client_env`. `render_client_env` runs last because it consumes the
  Resend values `run_prompts` just wrote and the `POSTGRES_PASSWORD` already
  sourced for `render_agent_dev_env`.
- **`db-migrate.sh` v1 covers Better Auth only.** Mastra continues to manage its
  own schema via its existing runtime path; the migrate script does not touch
  `chekku_agent`.
