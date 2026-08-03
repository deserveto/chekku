# Auth Env & Setup Production-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/setup-env.sh` generate a working, production-grade Better Auth client environment (secret + DB URL wired to the generated Postgres password + mirrored Resend values), add a dedicated `npm run db:migrate`, and update env examples + docs.

**Architecture:** `setup-env.sh` is the dev/bootstrap tool. It gains a `render_client_env` step (modeled on the existing `render_agent_dev_env`) that writes `client/.env.local` after the agent env is rendered and Resend is prompted. A new `scripts/db-migrate.sh` (+ `npm run db:migrate`) runs the Better Auth migration idempotently against `AUTH_DATABASE_URL`. Production injects the same vars via the host platform (documented); nothing is committed.

**Tech Stack:** Bash + inline `node` heredocs (existing script idiom), `dotenv`, `node:crypto`, `@better-auth/cli`, Vitest (`scripts/dev.test.ts` harness).

## Global Constraints

- `setup-env.sh` is dev/bootstrap only; production injects env via the host platform — never committed files.
- Generated/wired values live only in gitignored files (`client/.env.local`, `storage/.env.local`). `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, and the password inside `AUTH_DATABASE_URL` must never appear in script stdout (extend the existing leak guard).
- `BETTER_AUTH_SECRET` is always generated (`crypto.randomBytes(32).toString('base64url')`), never prompted; preserved on re-run.
- `AUTH_DATABASE_URL` is built from the generated `POSTGRES_PASSWORD` (pointing at `chekku_auth`, not `chekku_agent`); a non-placeholder user override is preserved.
- Ordering inside `setup-env.sh` is fixed: `sync_env_from_example` (client) → `run_prompts` → `render_agent_dev_env` → `render_client_env`.
- `db-migrate.sh` fails closed (non-zero, fixed message, no provider call) when `AUTH_DATABASE_URL` is empty.
- No new dependencies. No code comments unless asked. `npm run check` + `npm run build` must pass.

---

## File Structure

**Modified:**
| File | Change |
|------|--------|
| `scripts/setup-env.sh` | Add `render_client_env`; call it after `render_agent_dev_env`; update `print_summary`. |
| `client/.env.example` | Add `RESEND_API_KEY` / `RESEND_FROM_EMAIL`. |
| `package.json` (root) | Add `"db:migrate"` script. |
| Root `.env.example` | Add Client/Auth block. |
| `docs/OPERATIONS.md` | Rewrite Authentication subsection (generation + `db:migrate` + prod note). |
| `README.md` | Update client env table. |
| `scripts/dev.test.ts` | New cases for `render_client_env`, RESEND mirror, leak guard, `db-migrate.sh`. |

**New:**
| File | Role |
|------|------|
| `scripts/db-migrate.sh` | Idempotent Better Auth migration against `AUTH_DATABASE_URL`. |

---

## Task 1: `render_client_env` in setup-env.sh + client/.env.example RESEND

**Files:**
- Modify: `scripts/setup-env.sh` (add `render_client_env`, call it, update `print_summary`)
- Modify: `client/.env.example` (add RESEND vars)
- Modify: `scripts/dev.test.ts` (new cases)

**Interfaces:**
- Consumes: `POSTGRES_PASSWORD` (sourced from `storage/.env.local`), `agent/.env` (for RESEND mirror).
- Produces: `client/.env.local` with `BETTER_AUTH_SECRET`, `AUTH_DATABASE_URL`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.

- [ ] **Step 1: Add RESEND to client/.env.example**

Append to `client/.env.example`:

```
# Verification email transport (client-side). Optional in dev (server console
# fallback when RESEND_API_KEY is unset); required for real email delivery.
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

- [ ] **Step 2: Write the failing tests**

In `scripts/dev.test.ts`, first extend the secret-name set so the leak guard covers the auth secret. Find the existing `isSecretKeyName` / `storageSecretKeyNames` block (around line 51–65) and add an auth set:

```ts
const authSecretKeyNames = new Set(['BETTER_AUTH_SECRET']);
function isSecretKeyName(name: string): boolean {
  return storageSecretKeyNames.has(name) || searxngSecretKeyNames.has(name) || authSecretKeyNames.has(name);
}
```

(If the existing `isSecretKeyName` is defined differently, add `BETTER_AUTH_SECRET` to whichever set the function unions, preserving the existing shape.)

Then add a new `describe` block (mirror the existing setup-run helper used elsewhere in the file — read the surrounding tests for the exact `runSetup`/fixture pattern and reuse it):

```ts
describe('setup-env.sh: client auth env (render_client_env)', () => {
  it('generates a non-empty BETTER_AUTH_SECRET of at least 32 chars', () => {
    // run setup-env.sh in a fixture (reuse the existing harness helper)
    // parse client/.env.local
    const clientEnv = parse(readFileSync(`${fixtureDir}/client/.env.local`, 'utf8'));
    expect(clientEnv.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('wires AUTH_DATABASE_URL to the generated POSTGRES_PASSWORD at chekku_auth', () => {
    const clientEnv = parse(readFileSync(`${fixtureDir}/client/.env.local`, 'utf8'));
    const storageEnv = parse(readFileSync(`${fixtureDir}/storage/.env.local`, 'utf8'));
    expect(clientEnv.AUTH_DATABASE_URL).toBe(
      `postgresql://chekku:${storageEnv.POSTGRES_PASSWORD}@127.0.0.1:5432/chekku_auth`,
    );
  });

  it('overwrites the broken example placeholder AUTH_DATABASE_URL', () => {
    // pre-seed client/.env.local with the example placeholder before running setup
    // then assert the wired value replaced it (same as the test above)
  });

  it('preserves a user-set BETTER_AUTH_SECRET and a non-placeholder AUTH_DATABASE_URL override', () => {
    // pre-seed client/.env.local with BETTER_AUTH_SECRET=user-kept-secret
    //   and AUTH_DATABASE_URL=postgresql://chekku:x@remote.host:5432/chekku_auth
    // run setup, assert both values are unchanged in client/.env.local
  });

  it('mirrors prompted RESEND values from agent/.env into client/.env.local', () => {
    // pre-seed the fixture agent env with RESEND_API_KEY=rk_test + a RESEND_FROM_EMAIL
    // (run_prompts is skipped on non-TTY stdin in tests, so seed directly)
    // run setup, assert client/.env.local has the same RESEND_API_KEY + RESEND_FROM_EMAIL
  });

  it('does not leak BETTER_AUTH_SECRET or POSTGRES_PASSWORD to stdout', () => {
    // capture setup-env.sh stdout (existing tests already do this)
    // assert stdout does not contain the generated BETTER_AUTH_SECRET value
    //   nor the generated POSTGRES_PASSWORD value
  });
});
```

Use the file's existing fixture/run helpers verbatim — do not invent a new harness. If the existing tests run the full `setup-env.sh` once per test, mirror that; if they share a single setup run via a fixture created in `beforeEach`/`beforeAll`, reuse it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run scripts/dev.test.ts`
Expected: FAIL — `client/.env.local` still has empty `BETTER_AUTH_SECRET` and the placeholder `AUTH_DATABASE_URL`.

- [ ] **Step 4: Implement `render_client_env`**

In `scripts/setup-env.sh`, add this function (place it immediately after the existing `render_agent_dev_env` function definition, before `write_env_value`):

```bash
render_client_env() {
  if [[ ! -f "$CLIENT_ENV_FILE" ]]; then
    return 0
  fi

  local tmp
  tmp="$(mktemp "${CLIENT_ENV_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"

  set -a
  # shellcheck disable=SC1090
  source "$STORAGE_ENV_FILE"
  set +a

  node - "$CLIENT_ENV_FILE" "$AGENT_ENV_FILE" "$tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');
const { randomBytes } = require('node:crypto');

const [clientPath, agentPath, outputPath] = process.argv.slice(2);
const PLACEHOLDER_AUTH_DB = 'postgresql://chekku:chekku@localhost:5432/chekku_auth';
const postgresPassword = process.env.POSTGRES_PASSWORD;
if (!postgresPassword) throw new Error('Missing POSTGRES_PASSWORD in storage/.env.local');

const clientExisting = parse(readFileSync(clientPath, 'utf8'));
let agentExisting = {};
try {
  agentExisting = parse(readFileSync(agentPath, 'utf8'));
} catch {
  agentExisting = {};
}

const pickOwned = (name, fallback) => {
  const value = clientExisting[name];
  return typeof value === 'string' && value !== '' ? value : fallback;
};
const pickMirrored = (name) => {
  const value = agentExisting[name];
  return typeof value === 'string' ? value : '';
};

const secret = pickOwned('BETTER_AUTH_SECRET', randomBytes(32).toString('base64url'));
const userAuthDb = clientExisting.AUTH_DATABASE_URL;
const authDbUrl =
  typeof userAuthDb === 'string' && userAuthDb !== '' && userAuthDb !== PLACEHOLDER_AUTH_DB
    ? userAuthDb
    : `postgresql://chekku:${postgresPassword}@127.0.0.1:5432/chekku_auth`;
const betterAuthUrl = pickOwned('BETTER_AUTH_URL', 'http://localhost:3000');
const resendKey = pickMirrored('RESEND_API_KEY');
const resendFrom = pickMirrored('RESEND_FROM_EMAIL');

const updates = {
  BETTER_AUTH_SECRET: secret,
  AUTH_DATABASE_URL: authDbUrl,
  BETTER_AUTH_URL: betterAuthUrl,
  RESEND_API_KEY: resendKey,
  RESEND_FROM_EMAIL: resendFrom,
};

const serialize = (name, value) => {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain CR or LF`);
  const candidates = [
    value,
    `'${value}'`,
    `'${value.replaceAll("'", "\\'")}'`,
    `"${value}"`,
    `"${value.replaceAll('"', '\\"')}"`,
  ];
  const candidate = candidates.find((item) => (parse(`${name}=${item}`)[name] ?? '') === value);
  if (candidate === undefined) throw new Error(`${name} cannot be represented safely`);
  return `${name}=${candidate}`;
};

const source = readFileSync(clientPath, 'utf8');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const lines = source.split(/\r?\n/);
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
const handled = new Set();
const assignment = (line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
for (let i = 0; i < lines.length; i += 1) {
  const match = assignment(lines[i]);
  if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
    lines[i] = serialize(match[1], updates[match[1]]);
    handled.add(match[1]);
  }
}
for (const name of Object.keys(updates)) {
  if (!handled.has(name)) lines.push(serialize(name, updates[name]));
}
writeFileSync(outputPath, `${lines.join(eol)}${eol}`, { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  if [[ -f "$CLIENT_ENV_FILE" ]] && cmp -s "$tmp" "$CLIENT_ENV_FILE"; then
    rm "$tmp"
    chmod 600 "$CLIENT_ENV_FILE"
  else
    mv -f "$tmp" "$CLIENT_ENV_FILE"
    chmod 600 "$CLIENT_ENV_FILE"
  fi
}
```

Then call it in the main flow. Find the line `render_agent_dev_env` (near the end, around line 499) and add the new call immediately after it:

```bash
render_agent_dev_env
render_client_env
```

- [ ] **Step 5: Update `print_summary`**

In `print_summary`, add `client/.env.local` to the "Files updated from your input" list (around the line that prints `agent/.env`), and add a Next-step line. After the existing `echo "  - agent/.env"` line, add:

```bash
  echo "  - client/.env.local"
```

And after the "Rerun npm run setup after editing agent/.env." line, before `echo "Next step: npm run dev:sh"`, add:

```bash
  echo "Apply the auth schema once Postgres is running:"
  echo "  docker compose up -d postgres && npm run db:migrate"
  echo ""
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run scripts/dev.test.ts`
Expected: PASS — all new cases green, no regressions in existing cases.

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS (typecheck + lint + tests).

- [ ] **Step 8: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts client/.env.example
git commit -m "feat(setup): generate client auth env (secret + wired AUTH_DATABASE_URL + Resend mirror)"
```

---

## Task 2: `scripts/db-migrate.sh` + `npm run db:migrate`

**Files:**
- Create: `scripts/db-migrate.sh`
- Modify: `package.json` (root) — add script
- Modify: `scripts/dev.test.ts` — new case

**Interfaces:**
- Consumes: `AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` from `client/.env.local`.
- Produces: Better Auth schema in `chekku_auth` (side effect).

- [ ] **Step 1: Write the failing test**

In `scripts/dev.test.ts`, add a `describe` for `db-migrate.sh`. The test asserts it fails closed on an empty `AUTH_DATABASE_URL` without invoking the Better Auth CLI. Use the file's existing `executable()` helper to stub `npx` so the test can detect whether the CLI would have run:

```ts
describe('scripts/db-migrate.sh', () => {
  it('fails closed with a fixed message when AUTH_DATABASE_URL is empty and never invokes the CLI', () => {
    // build a tmpdir fixture:
    //   - client/.env.local with AUTH_DATABASE_URL=  (empty)
    //         and BETTER_AUTH_SECRET=anything
    //   - a stub `npx` on PATH (via executable()) that touches a marker file if ever called
    // run: bash <repo>/scripts/db-migrate.sh  with cwd = tmpdir root,
    //   PATH = <tmpdir bin>:<original PATH>, and an env var the script reads to locate client/.env.local
    //   (see "Implementation" below — the script resolves the repo root from BASH_SOURCE, so run it
    //    from a fixture that mirrors the repo layout OR set an override env var the script honors)
    const result = runDbMigrate({ authDbUrl: '' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/AUTH_DATABASE_URL|npm run setup/i);
    expect(existsSync(markerFile)).toBe(false);
  });
});
```

If the existing test harness runs scripts by repo-relative path against real `scripts/`, mirror that. The cleanest fixture approach: the script resolves its own root via `BASH_SOURCE`, so run the real `scripts/db-migrate.sh` but point it at a fixture `client/.env.local` via a `CHEKKU_CLIENT_ENV` override env var the script honors (see Step 2). The stub `npx` writes a marker if invoked.

- [ ] **Step 2: Implement `scripts/db-migrate.sh`**

Create `scripts/db-migrate.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLIENT_ENV_FILE="${CHEKKU_CLIENT_ENV:-$ROOT/client/.env.local}"

if [[ ! -f "$CLIENT_ENV_FILE" ]]; then
  echo "Missing $CLIENT_ENV_FILE. Run npm run setup first." >&2
  exit 1
fi

read_env_value() {
  node - "$CLIENT_ENV_FILE" "$1" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [path, name] = process.argv.slice(2);
process.stdout.write(parse(readFileSync(path, 'utf8'))[name] ?? '');
NODE
}

AUTH_DATABASE_URL="$(read_env_value AUTH_DATABASE_URL)"
if [[ -z "$AUTH_DATABASE_URL" ]]; then
  echo "AUTH_DATABASE_URL is empty in $CLIENT_ENV_FILE. Run npm run setup first." >&2
  exit 1
fi

export AUTH_DATABASE_URL
export BETTER_AUTH_SECRET="$(read_env_value BETTER_AUTH_SECRET)"
export BETTER_AUTH_URL="$(read_env_value BETTER_AUTH_URL)"

cd "$ROOT/client"
if ! npx -y @better-auth/cli migrate; then
  echo "Better Auth migration failed. Confirm Postgres is running and AUTH_DATABASE_URL is reachable." >&2
  exit 1
fi

echo "Better Auth schema applied to chekku_auth."
```

Note: the script honors `CHEKKU_CLIENT_ENV` so the test can point it at a fixture without a real repo layout; in normal use it resolves `client/.env.local` from the script location.

- [ ] **Step 3: Wire the npm script**

In the root `package.json` `scripts` block, add (alphabetized near the other scripts):

```json
"db:migrate": "bash ./scripts/db-migrate.sh",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/dev.test.ts`
Expected: PASS — the new case exits non-zero with the fixed message and the `npx` marker is absent.

- [ ] **Step 5: Manual happy-path check (live Postgres)**

This step is not unit-tested (needs live Postgres). With Postgres up and `client/.env.local` generated:

```bash
docker compose up -d postgres
npm run db:migrate
```

Confirm it applies/confirm the Better Auth tables exist in `chekku_auth` (`user`, `account`, `session`, `verification`). Record the result in the task report.

- [ ] **Step 6: Commit**

```bash
git add scripts/db-migrate.sh package.json scripts/dev.test.ts
git commit -m "feat(db): add npm run db:migrate for idempotent Better Auth schema migration"
```

---

## Task 3: Env examples + docs (root .env.example, OPERATIONS, README)

**Files:**
- Modify: root `.env.example`
- Modify: `docs/OPERATIONS.md`
- Modify: `README.md`

No unit tests; gate is `npm run check` + `npm run build` + `git diff --check`.

- [ ] **Step 1: Add Client/Auth block to root `.env.example`**

In root `.env.example`, replace the existing `# Client` block (the `AGENT_URL` / `NEXT_PUBLIC_APP_URL` / `AGENT_SERVICE_TOKEN` lines at the end) with:

```
# Client (Next.js) + Better Auth
AGENT_URL=http://localhost:4111
NEXT_PUBLIC_APP_URL=http://localhost:3000
AGENT_SERVICE_TOKEN=
# Better Auth email/password. In dev, npm run setup generates BETTER_AUTH_SECRET
# and wires AUTH_DATABASE_URL to the generated POSTGRES_PASSWORD in client/.env.local.
# In prod, inject these via the host platform; never commit them.
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_URL=postgresql://chekku:postgres@localhost:5432/chekku_auth
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

- [ ] **Step 2: Rewrite the OPERATIONS.md Authentication subsection**

In `docs/OPERATIONS.md`, find the `### Authentication` subsection (around line 114). Rewrite the env example block + surrounding prose to reflect generation (not placeholders). Replace the lines showing `BETTER_AUTH_SECRET=replace-with-32+-random-chars` and `AUTH_DATABASE_URL=postgresql://chekku:chekku@...` with:

```md
`npm run setup` generates `BETTER_AUTH_SECRET` (a 32+ char random value) and
writes `AUTH_DATABASE_URL` into `client/.env.local` using the same generated
`POSTGRES_PASSWORD` used by the agent's `DATABASE_URL`. You do not type the
secret or the password by hand.

After setup, apply the Better Auth schema once Postgres is running:

    docker compose up -d postgres
    npm run db:migrate

`npm run db:migrate` runs `@better-auth/cli migrate` against `AUTH_DATABASE_URL`
and is safe to re-run.
```

Then add a **Production** paragraph at the end of the subsection:

```md
**Production:** inject `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`AUTH_DATABASE_URL`, and (for real email delivery) `RESEND_API_KEY` /
`RESEND_FROM_EMAIL` via the hosting platform's secret or env configuration —
not via committed files. Set `BETTER_AUTH_URL` to the real **HTTPS** origin so
Better Auth issues `secure` session cookies. Run `npm run db:migrate` as a
deploy release step.
```

- [ ] **Step 3: Update README.md client env table**

In `README.md`, find the client environment table (the section listing `AGENT_URL`, `NEXT_PUBLIC_APP_URL`, etc.). Add rows for `BETTER_AUTH_SECRET` (generated by `npm run setup`), `BETTER_AUTH_URL` (defaults to `http://localhost:3000`; set to the HTTPS origin in prod), `AUTH_DATABASE_URL` (auto-wired to `chekku_auth`), `RESEND_API_KEY` (optional; dev console fallback when unset), and `RESEND_FROM_EMAIL`. Update the setup instructions to say `npm run setup` then `npm run db:migrate`.

- [ ] **Step 4: Run full check + build**

Run: `npm run check && npm run build`
Expected: both PASS.

- [ ] **Step 5: Whitespace check**

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/OPERATIONS.md README.md
git commit -m "docs: document generated auth env, npm run db:migrate, and prod injection"
```

---

## Final Verification (run before declaring done)

- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] Manual: on a clean clone, `npm run setup` produces a `client/.env.local` whose `BETTER_AUTH_SECRET` is non-empty and whose `AUTH_DATABASE_URL` matches the `POSTGRES_PASSWORD` in `storage/.env.local` (pointing at `chekku_auth`); `docker compose up -d postgres && npm run db:migrate` applies the schema; sign-up → verify (console fallback) → sign-in works end to end.

---

## Notes For The Implementer

- **Reuse the existing harness.** `scripts/dev.test.ts` already runs `setup-env.sh` in tmpdir fixtures, parses output files with `dotenv`, and runs a stdout secret-leak guard. Mirror the surrounding test helpers exactly; do not invent a parallel harness.
- **`render_client_env` must run after `run_prompts` and `render_agent_dev_env`.** It reads `POSTGRES_PASSWORD` (sourced from `storage/.env.local`) and mirrors RESEND from `agent/.env`, both of which exist by then.
- **The placeholder `AUTH_DATABASE_URL=postgresql://chekku:chekku@...` in `client/.env.example` is intentionally overwritten** — that is the broken value the generator fixes. Only a non-placeholder user override is preserved.
- **`scripts/dev.test.ts` is excluded from the main `npm test` run** (see root `package.json`: `vitest run --exclude scripts/dev.test.ts && vitest run scripts/dev.test.ts`). Run it explicitly with `npx vitest run scripts/dev.test.ts`.
- **`db-migrate.sh` happy path needs live Postgres** and is a manual check, not a unit test (the unit test only covers the fail-closed path). This matches how the original auth migration was validated.
