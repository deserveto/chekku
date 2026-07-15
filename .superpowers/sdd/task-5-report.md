# Task 5 Report

## Status

Implemented generic local Garage runtime and environment handling for bucket
`chekku-objects`.

## Changes

- Added Garage v2.3.0 Compose service on ports 3900-3903 with health bounds,
  generated configuration, and persistent metadata/data volumes.
- Added stable private credential generation and secret-safe propagation into
  `agent/.env.development`.
- Replaced stale Garage assignments while preserving unrelated agent dotenv
  values.
- Added bounded health polling, port conflict checks, config-driven recreation,
  and deterministic tmux/process cleanup.
- Added exactly five application variables: `GARAGE_ENDPOINT`,
  `GARAGE_REGION`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY_ID`, and
  `GARAGE_SECRET_ACCESS_KEY`.
- Added launcher tests to root Vitest discovery and `npm run dev:sh`.

## TDD Evidence

- RED: `npx vitest run scripts/dev.test.ts agent/src/config/env.test.ts`
  failed 15 tests because runtime files and Garage schema were absent.
- GREEN: same command passed 17 tests across 2 files.

## Verification

- `npx vitest run scripts/dev.test.ts agent/src/config/env.test.ts`: 17 passed.
- `npm run check`: 30 files and 167 tests passed; typecheck and lint passed.
- `npm run build`: agent and client builds passed.
- Git Bash syntax check passed for both shell scripts.
- `git diff --check` passed.

## Remaining Review Fixes

- Added application-process Garage allowlisting. Fallback and tmux launches
  remove every `GARAGE_*` variable except the five documented application
  values, including admin, RPC, metrics, bootstrap, config-change, and
  caller-injected variables.
- Added decimal normalization before arithmetic. Values such as `030`, `099`,
  and `0001` use base-10 semantics; timeout output uses canonical values.
- Added remaining-time watchdogs around Garage `docker compose ps` and
  `docker inspect` calls. Timed-out process groups receive TERM then KILL,
  temporary output is private, and errors expose no command output or secrets.

## Remaining Review TDD Evidence

- RED: focused suite failed 4 tests for leading-zero rejection, unbounded
  Docker `ps`/`inspect`, and leaked Garage runtime secrets in actual npm child
  environments.
- RED: caller-injected `GARAGE_UNRELATED` reached both application processes
  until cleanup changed from a known-secret list to a five-variable allowlist.
- GREEN: `npx vitest run scripts/dev.test.ts agent/src/config/env.test.ts`
  passed 22 tests across 2 files.
- Git Bash syntax validation passed for both shell scripts.
- `npm run check` passed typecheck, lint, 30 test files, and 172 tests.
- `npm run build` passed agent and client production builds.
- `git diff --check` passed.
- Docker exists, but `storage/.env.local` does not. Compose config validation
  was skipped without generating or reading local credentials.

## Self-Review

No blocking findings. Runtime output exposes endpoint, region, and bucket only.
Generated credentials, configuration, and local data remain ignored.

## Commit

`feat(dev): add local Garage runtime`

## Review Fixes

- Replaced attempt-count readiness polling with elapsed-time deadline polling.
  Readiness timeout is validated from 1 to 300 seconds, polling interval is
  clamped before arithmetic, and timeout output reports configured duration.
- Added silent `docker compose --env-file storage/.env.local config --quiet`
  validation after env/config generation and before any service inspection or
  startup. Failure returns actionable output without printing environment
  values.
- Expanded stale Garage assignment removal to accept dotenv-valid `export`,
  leading whitespace, and whitespace before `=` while preserving unrelated
  lines and safe value serialization.

## Review TDD Evidence

- RED: focused suite failed 3 regression tests for stale assignment variants,
  missing Compose validation, and unbounded readiness sleep.
- RED: overflow-scale interval regression independently failed by hanging until
  the test timeout before pre-arithmetic clamping was added.
- GREEN: `npx vitest run scripts/dev.test.ts agent/src/config/env.test.ts`
  passed 18 tests across 2 files.
- Git Bash syntax validation passed for `scripts/dev.sh` and
  `scripts/storage-env.sh`.
- `npm run check` passed typecheck, lint, 30 test files, and 168 tests.
- `npm run build` passed agent and client production builds.
- `git diff --check` passed.
