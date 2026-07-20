# Single-Entry Environment Setup Script

## Status

Approved for implementation planning on 2026-07-20.

## Goal

Provide a single `scripts/setup-env.sh` that bootstraps and reconciles all
local Chekku environment files. The script auto-generates every value that can
be auto-generated (Garage and SearXNG service secrets, fixed defaults), and for
values that must come from the user it prompts interactively with sensible
defaults, then prints a clear checklist of anything still empty.

The script replaces the three-script split (`scripts/dev.sh` sourcing
`scripts/storage-env.sh` and `scripts/searxng-env.sh`) with one user-facing
setup tool plus a thinner launcher. `dev.sh` continues to start the same local
services and processes; it just no longer performs first-time generation.

## Existing Invariants

The change must preserve these boundaries:

- All generated local files remain gitignored:
  `agent/.env`, `agent/.env.development`, `client/.env.local`,
  `storage/.env.local`, `storage/.garage/`, `searxng/.env.local`.
- Service-only secrets stay out of application environments:
  - `storage/.env.local` keeps `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`,
    `GARAGE_METRICS_TOKEN`.
  - `searxng/.env.local` keeps `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`.
- Only the five Garage application values
  (`GARAGE_ENDPOINT`, `GARAGE_REGION`, `GARAGE_BUCKET`,
  `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`) propagate to
  `agent/.env.development`.
- Only `SEARXNG_BASE_URL` and empty `SEARXNG_API_KEY` propagate to
  `agent/.env.development`.
- The Next.js client process receives zero `SEARXNG_*` values and no Garage
  service-only secrets.
- Application env examples (`agent/.env.example`, `client/.env.example`)
  remain the source of truth for which variables exist and their default
  values. Tracked examples never contain real secrets.
- Generation writes files with mode `0600` and never logs secret values,
  endpoints, bearer tokens, request IDs, or upstream bodies.
- Atomic writes via `mktemp` + `mv` are preserved so a partial file is never
  observed by another process.
- AGENTS.md security rules for env files, secrets, and ignored generated
  artifacts continue to apply unchanged.
- `npm run dev:sh` remains the documented developer entry point and continues
  to provision Garage + SearXNG before starting agent and client workspaces.
- The repository command surface remains `npm run dev:sh`, `npm run dev`,
  `npm run dev:agent`, `npm run dev:client`, plus the new
  `npm run setup` convenience wrapper.

## Selected Architecture

`scripts/setup-env.sh` is a single bash script with embedded Node snippets
for parsing, serialization, and secret generation. It runs in two implicit
modes determined by the presence of `agent/.env`:

1. **Initial mode** — `agent/.env` does not exist. Bootstrap from
   `.env.example` files, generate every auto-generatable value, then prompt
   the user for required and optional application fields.
2. **Sync mode** — `agent/.env` exists. Diff it against
   `agent/.env.example`, insert any new variables without overwriting
   existing values, regenerate local service files only if missing or
   invalid, re-render `garage.toml` and `agent/.env.development`, then prompt
   only for required variables that are still empty.

Both modes are idempotent. Re-running the script with everything in place
produces no changes and exits successfully.

The script does not call any other shell script. All Garage and SearXNG
generation logic previously in `scripts/storage-env.sh` and
`scripts/searxng-env.sh` is folded into `setup-env.sh` as Node helpers
invoked from bash. The two old scripts are deleted.

`scripts/dev.sh` no longer sources any generation script. It sources the
generated `.env.local` files directly so the spawned agent and client
subprocesses inherit the same exports. `GARAGE_CONFIG_CHANGED` (previously
set by `storage-env.sh`) moves into `dev.sh` as a SHA-256 comparison of
`storage/.garage/garage.toml` against a persisted `storage/.garage/.applied-hash`
written after the service becomes healthy.

## Component Layout

```text
scripts/
  setup-env.sh           # NEW — single user-facing setup entry point
  dev.sh                 # MODIFIED — sources generated files, hash-based config detection
  dev.test.ts            # REWRITTEN — ported storage/searxng tests to setup-env.sh
storage/
  .env.local             # GENERATED — Garage application + service secrets
  garage.toml.template   # TRACKED — template consumed by setup-env.sh
  .garage/
    garage.toml          # GENERATED — rendered from template
    .applied-hash        # GENERATED — last-applied toml hash (written by dev.sh)
searxng/
  .env.local             # GENERATED — SearXNG service secret + hash
agent/
  .env                   # USER — copied from .env.example, edited by user
  .env.development       # GENERATED — app-facing keys propagated by setup-env.sh
client/
  .env.local             # USER — copied from .env.example, rarely edited
```

## setup-env.sh Pipeline

The script executes these steps in order. Each step is internally idempotent.

### Step 1 — Prerequisites

- Resolve repo root from `BASH_SOURCE`.
- Require `node` on `PATH`. Abort with actionable message if missing.
- Require `agent/.env.example` and `client/.env.example` to exist.
- Warn (do not abort) if `docker compose` is unavailable, since the script
  itself does not start services.

### Step 2 — Ensure `agent/.env` and `client/.env.local` exist

- If `agent/.env` is missing, copy `agent/.env.example` → `agent/.env` with
  mode `0600` and record `MODE=initial`. Otherwise record `MODE=sync`.
- If `client/.env.local` is missing, copy `client/.env.example` →
  `client/.env.local` with mode `0600`.

### Step 3 — Sync `agent/.env` against `agent/.env.example`

Implemented as a Node helper invoked from bash:

- Parse both files with `dotenv`.
- Identify variables present in `.env.example` but missing from `.env`.
- Append each missing variable to the end of `.env` under a single
  clearly-marked section header
  (`# Added by setup-env.sh (synced from .env.example)`) so the user can
  review and reorder manually. The inserted value is the example default.
  Position-within-example preservation is explicitly out of scope to keep
  the sync algorithm predictable and easy to test.
- Variables present in `.env` but not in `.env.example` are preserved
  verbatim (user customization).
- Existing values in `.env` are **never** overwritten.
- The sync section header is inserted only once across multiple runs;
  subsequent syncs append new variables under the existing header.
- Atomic write via `mktemp` + `cmp` + `mv` to keep the file mode and avoid
  spurious mtime churn when content is unchanged.

The same sync runs against `client/.env.local` vs `client/.env.example`.

### Step 4 — Generate `storage/.env.local` (Garage)

Idempotent. If the file exists and parses cleanly with all required keys
present, leave it. Otherwise generate via Node:

- `GARAGE_ENDPOINT=http://127.0.0.1:3900`
- `GARAGE_REGION=garage`
- `GARAGE_BUCKET=chekku-objects`
- `GARAGE_ACCESS_KEY_ID=GK${uppercase hex(12)}`
- `GARAGE_SECRET_ACCESS_KEY=${hex(32)}`
- `GARAGE_RPC_SECRET=${hex(32)}`
- `GARAGE_ADMIN_TOKEN=${base64url(32)}`
- `GARAGE_METRICS_TOKEN=${base64url(32)}`

Random values use `crypto.randomBytes`. File mode `0600`.

### Step 5 — Generate `searxng/.env.local`

Idempotent. If the file exists and validates against the strict shape
(`SEARXNG_SECRET` is 43 chars base64url, `SEARXNG_CONFIG_HASH` is 64 hex,
`SEARXNG_BASE_URL` is `http://127.0.0.1:8888`, `SEARXNG_API_KEY` empty),
leave it. Otherwise generate via Node:

- `SEARXNG_SECRET` — random `base64url(32)`, persisted across runs.
- `SEARXNG_CONFIG_HASH` — SHA-256 of `searxng/settings.yml`. Regenerated
  when the tracked settings change.
- `SEARXNG_BASE_URL=http://127.0.0.1:8888`
- `SEARXNG_API_KEY=` (always empty here; user may set it manually for an
  external authenticated reverse proxy.)

When the tracked `searxng/settings.yml` changes, `SEARXNG_CONFIG_HASH` is
regenerated but `SEARXNG_SECRET` is preserved so the local SearXNG volume
remains usable.

### Step 6 — Render `storage/.garage/garage.toml`

- `mkdir -p storage/.garage`.
- Read `storage/garage.toml.template`.
- Substitute `${GARAGE_RPC_SECRET}`, `${GARAGE_ADMIN_TOKEN}`,
  `${GARAGE_METRICS_TOKEN}`, `${GARAGE_REGION}` from the loaded
  `storage/.env.local`.
- Atomic write to `storage/.garage/garage.toml` with mode `0600`.

### Step 7 — Render `agent/.env.development`

Implemented in Node so it can correctly handle dotenv quoting:

- Source `agent/.env` content as the base.
- Remove every existing `GARAGE_*` assignment (including multi-line quoted
  values).
- Remove every existing `SEARXNG_*` assignment.
- Append the five Garage application values from `storage/.env.local`.
- Append `SEARXNG_BASE_URL` and empty `SEARXNG_API_KEY`.
- Verify the loaded `storage/.env.local` and `searxng/.env.local` values
  for `SEARXNG_SECRET` / `SEARXNG_CONFIG_HASH` do not appear anywhere in
  the rendered `agent/.env.development` (security boundary check).
- Atomic write with mode `0600`.

If `agent/.env` is absent, do not create `agent/.env.development` either.
This matches the existing `dev.sh` behavior of refusing to start without
`agent/.env`.

### Step 8 — Interactive prompts

Only run when stdin is a TTY. If stdin is piped (e.g. CI), skip prompts and
rely on the printed checklist at step 9.

For each field, skip the prompt if the current value is non-empty.

**Required (no default, script blocks until non-empty):**

- `LLM_API_KEY` — prompt with `read -s`, confirm input length is non-zero,
  re-prompt on empty. Echo nothing back.

**Defaults offered (Enter to accept):**

- `LLM_BASE_URL` — default `https://llm.rafiqspace.ai/v1`
- `LLM_DEFAULT_MODEL` — default `qwen3.6-35b-a3b-fast`
- `LLM_DISPLAY_NAME` — default `Rafiqspace LLM`
- `LLM_MODELS` — default `qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b`
- `RESEND_FROM_EMAIL` — default `Chekku <onboarding@resend.dev>`

**Optional (Enter to skip, leaves value empty):**

- `TELEGRAM_BOT_TOKEN`
- `RESEND_API_KEY`
- `AGENT_SERVICE_TOKEN`

Each accepted value is written back to `agent/.env` via the same atomic
Node helper used by step 3.

### Step 9 — Summary

Print to stdout:

```text
Setup complete.

Files generated:
  - storage/.env.local
  - storage/.garage/garage.toml
  - searxng/.env.local
  - agent/.env.development

Files updated from your input:
  - agent/.env

Required values you still need to fill (edit agent/.env):
  - LLM_API_KEY   (get one from your OpenAI-compatible endpoint)

Optional integrations you can configure later:
  - TELEGRAM_BOT_TOKEN   (social-media-agent)
  - RESEND_API_KEY       (send-email tool)
  - MAESTRO_ENABLED      (qa-android-agent)

Next step: npm run dev:sh
```

Service secrets are never printed.

## dev.sh Changes

Replace:

```bash
source "$ROOT/scripts/storage-env.sh"
source "$ROOT/scripts/searxng-env.sh"
```

With direct loads from the generated files:

```bash
[[ -f "$ROOT/storage/.env.local" ]] || {
  echo "Missing storage/.env.local. Run scripts/setup-env.sh first." >&2
  exit 1
}
[[ -f "$ROOT/searxng/.env.local" ]] || {
  echo "Missing searxng/.env.local. Run scripts/setup-env.sh first." >&2
  exit 1
}
set -a
# shellcheck disable=SC1090
source "$ROOT/storage/.env.local"
# shellcheck disable=SC1090
source "$ROOT/searxng/.env.local"
set +a

# Application-facing subset for the agent process.
export GARAGE_ENDPOINT GARAGE_REGION GARAGE_BUCKET \
       GARAGE_ACCESS_KEY_ID GARAGE_SECRET_ACCESS_KEY
export SEARXNG_BASE_URL SEARXNG_API_KEY
```

Replace the `GARAGE_CONFIG_CHANGED` derivation:

```bash
TOML_FILE="$ROOT/storage/.garage/garage.toml"
APPLIED_HASH_FILE="$ROOT/storage/.garage/.applied-hash"
TOML_HASH="$(sha256sum "$TOML_FILE" | cut -d' ' -f1)"
APPLIED_HASH=""
[[ -f "$APPLIED_HASH_FILE" ]] && APPLIED_HASH="$(cat "$APPLIED_HASH_FILE")"
GARAGE_CONFIG_CHANGED=0
if [[ -n "$TOML_HASH" && "$TOML_HASH" != "$APPLIED_HASH" ]]; then
  GARAGE_CONFIG_CHANGED=1
fi
```

After `ensure_service_ready garage` succeeds, write the current toml hash:

```bash
printf '%s' "$TOML_HASH" > "$APPLIED_HASH_FILE"
```

The `garage_app_cleanup`, `searxng_agent_cleanup`, and
`searxng_client_cleanup` shell snippets that strip service-only values
before spawning agent and client subprocesses are preserved unchanged.

The remaining dev.sh logic (tmux split, port conflict detection, signal
handling, graceful shutdown) is unchanged.

The validation block at `dev.sh:13-24` that requires `LLM_BASE_URL`,
`LLM_API_KEY`, and `LLM_DEFAULT_MODEL` in `agent/.env` is preserved.

## Variable Classification

| Variable | Source | Required | Notes |
| --- | --- | --- | --- |
| `GARAGE_ENDPOINT` | auto | yes | Fixed `http://127.0.0.1:3900` |
| `GARAGE_REGION` | auto | yes | Fixed `garage` |
| `GARAGE_BUCKET` | auto | yes | Fixed `chekku-objects` |
| `GARAGE_ACCESS_KEY_ID` | auto | yes | Random `GK${hex}` |
| `GARAGE_SECRET_ACCESS_KEY` | auto | yes | Random hex |
| `GARAGE_RPC_SECRET` | auto | service-only | Random hex, never exported to app |
| `GARAGE_ADMIN_TOKEN` | auto | service-only | Random base64url, never exported |
| `GARAGE_METRICS_TOKEN` | auto | service-only | Random base64url, never exported |
| `SEARXNG_SECRET` | auto | service-only | Random base64url, never exported |
| `SEARXNG_CONFIG_HASH` | auto | service-only | SHA-256 of `searxng/settings.yml` |
| `SEARXNG_BASE_URL` | auto | yes | Fixed `http://127.0.0.1:8888` |
| `SEARXNG_API_KEY` | user | no | Empty by default for local |
| `LLM_API_KEY` | user | yes | Prompted, hidden input |
| `LLM_BASE_URL` | user | yes | Prompted with default |
| `LLM_DEFAULT_MODEL` | user | yes | Prompted with default |
| `LLM_DISPLAY_NAME` | user | no | Prompted with default |
| `LLM_MODELS` | user | no | Prompted with default |
| `TELEGRAM_BOT_TOKEN` | user | conditional | Prompted, skippable |
| `RESEND_API_KEY` | user | conditional | Prompted, skippable |
| `RESEND_FROM_EMAIL` | user | no | Prompted with default |
| `AGENT_SERVICE_TOKEN` | user | no | Prompted, skippable |

## Testing Approach

The existing `scripts/dev.test.ts` is rewritten in place to cover both
`setup-env.sh` and the modified `dev.sh`. The test runner remains Vitest
with bash as the subprocess shell (Git Bash on Windows, native bash
elsewhere).

Ported from the deleted-script tests:

- Garage key generation: idempotency, format, mode `0600`.
- Garage `toml` template substitution: missing keys abort cleanly.
- `agent/.env.development` rendering: app-facing keys present, service-only
  secrets absent, multi-line quoting handled correctly.
- SearXNG secret persistence: regenerated only when settings change.
- SearXNG leak guard: service-only values never enter agent env.

New for `setup-env.sh`:

- Initial mode end-to-end: from empty fixture to a complete env tree.
- Sync mode: pre-populated `agent/.env` keeps existing values; new example
  vars are inserted; removed-from-example vars are preserved.
- Idempotency: running twice produces no diff.
- TTY detection: piped stdin skips prompts.
- Required prompt: empty `LLM_API_KEY` re-prompts; piped non-empty input
  is accepted.
- Atomic writes: concurrent reads never observe partial files.
- Security boundary: rendered `agent/.env.development` never contains
  service-only secrets even when examples are adversarial.

New for `dev.sh`:

- Missing `storage/.env.local` aborts with the new actionable message.
- Hash-based `GARAGE_CONFIG_CHANGED`: clean fixture ⇒ `0`; modified toml ⇒
  `1`; after successful start, `.applied-hash` matches the toml hash.

The existing launcher tests (tmux, port conflicts, signal handling,
timeout normalization) are preserved with the minimum changes needed for
the new fixture shape.

## Documentation Updates

- `README.md` — Quick start section: replace the two `cp` commands and
  the manual `.env` edit instruction with `npm run setup`, followed by
  `npm run dev:sh`. Keep the manual-edit fallback in troubleshooting.
- `docs/OPERATIONS.md` — replace references to
  `scripts/searxng-env.sh` and `scripts/storage-env.sh` with
  `scripts/setup-env.sh`. Note that `npm run dev:sh` no longer regenerates
  files; it only starts services.
- `.env.example` line 29 — update comment to reference
  `scripts/setup-env.sh`.
- `agent/.env.example` lines 34, 39 — same comment update.
- `package.json` — add `"setup": "bash ./scripts/setup-env.sh"` alongside
  the existing `dev:sh` entry.

## Security Review

- The script writes only to gitignored paths.
- No secret is ever printed, logged, or written to a tracked file.
- Service-only secrets (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`,
  `GARAGE_METRICS_TOKEN`, `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`) are
  never copied into `agent/.env.development` or any application
  environment.
- The `SEARXNG_API_KEY` is always empty when generated locally; users who
  need a bearer token for an external reverse proxy set it manually in
  `agent/.env`.
- The interactive prompt uses `read -s` for `LLM_API_KEY` and other
  secrets so they do not appear in the terminal scrollback.
- File mode `0600` is enforced on every generated file.
- Atomic writes via `mktemp` + `mv` prevent partial reads.

## Non-Goals

- No Windows-native PowerShell port. Bash via Git Bash remains the only
  supported shell, matching the existing convention.
- No CI workflow changes. CI continues to run `npm run check` and
  `npm run build`; it does not invoke `setup-env.sh` directly.
- No production deployment behavior. Production continues to use a secret
  manager; `setup-env.sh` is local-dev only.
- No support for arbitrary custom env files outside the documented set.
- No interactive editor for already-filled values. Sync mode preserves
  existing values; users edit `agent/.env` directly to change them.
- No multi-environment profiles (e.g. `dev` vs `staging`); the single
  `agent/.env` pattern is preserved.

## File-by-File Plan

| File | Action | Notes |
| --- | --- | --- |
| `scripts/setup-env.sh` | create | New ~400 LoC entry script |
| `scripts/storage-env.sh` | delete | Logic folded into `setup-env.sh` |
| `scripts/searxng-env.sh` | delete | Logic folded into `setup-env.sh` |
| `scripts/dev.sh` | modify | Source generated files; hash-based config detection |
| `scripts/dev.test.ts` | rewrite | Port old tests; add new mode, sync, prompt tests |
| `package.json` | modify | Add `setup` npm script |
| `README.md` | modify | Quick start, troubleshooting |
| `docs/OPERATIONS.md` | modify | Script references |
| `.env.example` | modify | Comment update only |
| `agent/.env.example` | modify | Comment update only |

## Completion Checklist

- [ ] `scripts/setup-env.sh` runs in initial mode on an empty fixture.
- [ ] `scripts/setup-env.sh` runs in sync mode on a partially-populated
      fixture without overwriting existing values.
- [ ] Both modes are idempotent on re-run.
- [ ] Service-only secrets never appear in `agent/.env.development`.
- [ ] `scripts/storage-env.sh` and `scripts/searxng-env.sh` are deleted.
- [ ] `scripts/dev.sh` sources generated files and detects config changes
      via SHA-256.
- [ ] `scripts/dev.test.ts` covers all ported and new scenarios.
- [ ] `npm run check` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] `README.md`, `docs/OPERATIONS.md`, `.env.example`, and
      `agent/.env.example` references are updated.
- [ ] AGENTS.md invariants are preserved unchanged.
