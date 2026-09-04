# Compose prod/dev split — design

- **Date:** 2026-09-01
- **Status:** Approved (design discussion 2026-09-01)
- **Scope:** `compose.yaml` → three Compose files; `scripts/dev.sh`, `scripts/prod.sh`, `scripts/setup-env.sh`; script tests; AGENTS.md / README / docs.

## Context

Today a single `compose.yaml` serves both environments. The five infra services
(garage, searxng, reader, qdrant, postgres) run in both modes with **unconditional
loopback `ports:` blocks**, while `agent` and `client` are gated behind
`profiles: [prod]`. Production's *public* surface is already minimal — nginx
proxies the one public URL to `127.0.0.1:3000` — but the file structure itself
carries the dev launcher's port bindings into every deployment, so the production
port contract is stated nowhere and dev bindings land on the prod host as five
extra loopback listeners.

The operator constraint driving this change: **production cannot afford
provisioned ports beyond the one public URL.** The current AGENTS.md invariant
("kept apart by Compose profiles, not by separate files") is deliberately
reversed by this design; AGENTS.md is updated as part of the work.

## Goals

- Production exposes **exactly two loopback bindings**: client `127.0.0.1:3000`
  (the existing 1 public URL via nginx) and postgres `127.0.0.1:5432` (host-run
  `db-migrate.sh` / `pg_dump`). Everything else stays on the Compose network.
- Development keeps today's five loopback publishes and identical launcher
  behavior.
- Infra service definitions (image pins, healthchecks, volumes) exist **once** —
  no duplication, no drift.
- No Compose merge magic (`!reset` / `!override` YAML tags).

## Non-goals

- No change to nginx config, env var names, service names, network/volume names,
  image pins, or healthchecks.
- No containerized one-shot migration (host-run `db-migrate.sh` via loopback
  5432 stays). Follow-up if "zero extra listeners" is ever required.
- No admin/debug exposure on prod (no agent :4111, no Qdrant dashboard, no
  Garage/SearXNG UIs).

## Design

### Files

**1. `compose.yaml` — shared infra base, definitions only.**
Garage, searxng, reader, qdrant, postgres keep their current image, command,
restart policy, environment, volumes, and healthcheck blocks verbatim. The
`ports:` blocks are **removed entirely** (the file must contain no `ports:` key
at all). The `networks:` (`default: name: chekku-network`) and `volumes:` blocks
stay. A header comment states this is the base file, always paired with an
overlay, and that `scripts/dev.sh` / `scripts/prod.sh` are the supported entry
points.

**2. `compose.dev.yaml` — dev overlay: loopback publishes only.**
Five service entries, each carrying only the exact `ports:` binding it has
today:

| service  | binding                                              |
|----------|------------------------------------------------------|
| garage   | `127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900`    |
| searxng  | `127.0.0.1:${CHEKKU_SEARXNG_HOST_PORT:-8888}:8080`   |
| reader   | `127.0.0.1:${CHEKKU_READER_HOST_PORT:-8081}:8081`    |
| qdrant   | `127.0.0.1:${CHEKKU_QDRANT_HOST_PORT:-6333}:6333`    |
| postgres | `127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432`  |

**3. `compose.prod.yaml` — prod overlay: application containers.**
The `agent` and `client` services move here verbatim from the current
`profiles: [prod]` block (build contexts, `depends_on`, environment, healthchecks
unchanged; the `profiles:` key is dropped). The client keeps its single
`127.0.0.1:${CHEKKU_CLIENT_HOST_PORT:-3000}:3000` publish. A `postgres` entry
carrying only the publish
`127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432` (same form as today,
including the host-port override) is added, with a comment explaining it exists
for host-run `db-migrate.sh` and `pg_dump`, and that a loopback binding is not a
provisioned public port.

Merge semantics make this safe without reset tags: per-service lists append, and
the base declares no ports, so each merged environment has exactly its overlay's
bindings and nothing else.

### Scripts

- **`scripts/dev.sh`** — a `DEV_COMPOSE=(docker compose --env-file
  storage/.env.local -f compose.yaml -f compose.dev.yaml)` array replaces every
  inline `docker compose --env-file storage/.env.local …` invocation (config
  validation, `ps`, `up`).
- **`scripts/prod.sh`** — `COMPOSE=(docker compose --env-file storage/.env.local
  -f compose.yaml -f compose.prod.yaml)`; the `--profile prod` flag is dropped;
  the header comment and the invalid-config message name the new files.
- **`scripts/setup-env.sh`** — the printed hint becomes
  `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres && npm run db:migrate`
  (a bare `up` would no longer publish 5432).
- **`scripts/db-migrate.sh`** — unchanged; `AUTH_DATABASE_URL` keeps its
  `127.0.0.1:5432` form in both environments.
- Root `package.json` scripts unchanged (they delegate to the shell scripts).

### Behavior guarantees

- Bare `docker compose up` (no `-f`) now starts infra with **no** host
  listeners — a safe default for operators who skip the scripts.
- Project name, `chekku-network`, volume names, and service names are untouched,
  so existing dev and prod deployments upgrade in place: `scripts/prod.sh up`
  recreates the containers whose config changed (infra loses its loopback
  publishes on prod except postgres; agent/client keep their identity) and
  volumes persist.
- The fail-closed story is unchanged: `${VAR:-}` defaults remain in the
  agent/client environment blocks so `prod.sh down` and `build` work without
  secrets, and `require_env` remains the single fail-closed gate for `up`.
- Because the scripts pass explicit `-f` lists, the auto-loaded
  `docker-compose.override.yaml` no longer merges. AGENTS.md's escape-hatch
  wording is updated: machine-specific overrides are supplied as an additional
  `-f` when invoking Compose manually. The scripts intentionally gain no
  override hook (YAGNI).

## Testing

- **`scripts/dev.test.ts`** ("committed local runtime"): image, mount, volume,
  and healthcheck assertions stay on `compose.yaml`; the port-binding assertions
  move to `compose.dev.yaml`; add a negative assertion that `compose.yaml` has
  no `ports:` key at all; assert `dev.sh` carries the `-f` pair on every compose
  invocation.
- **`scripts/prod.test.ts`**: the "always activates the prod profile" test
  becomes "always passes the prod overlay" — every non-version compose line
  contains `--env-file storage/.env.local`, `-f compose.yaml`, and
  `-f compose.prod.yaml`, and no line contains `--profile`. New static
  assertions: `compose.prod.yaml` contains exactly the two loopback publishes
  (client 3000, postgres 5432), the agent service declares no ports, and
  garage's internal 3901/3902/3903 ports appear in no published binding in any
  Compose file.
- Full `npm run check` and `npm run build` must pass (per completion checklist).

## Documentation

- **AGENTS.md** — the Production containerization bullet "kept apart by Compose
  profiles, not by separate files" is inverted: development and production are
  kept apart by overlay files over the shared port-less infra base; the
  `--profile prod` references in the launcher descriptions and the
  `docker-compose.override.yaml` escape-hatch sentence are updated to match.
- **README.md** — dev/prod quickstart commands.
- **docs/OPERATIONS.md** — commands and the port-exposure story per environment.
- **docs/ARCHITECTURE.md** — the Compose structure description.

## Rollout

- Dev machines: `git pull`, then use `npm run dev:sh` as usual. The effective
  dev config is unchanged, but Compose stamps the invoked file list into a
  container label, so the five infra containers are recreated once on the next
  `up`; volumes persist.
- Prod: `git pull`, then `scripts/prod.sh down && scripts/prod.sh up` (or plain
  `up`; Compose recreates drifted services, including the same one-time
  config-file label change). Brief recreate downtime; volumes persist; the
  public URL is unaffected beyond that window.

## Follow-ups (out of scope)

- One-shot containerized `db:migrate` if the prod host must have exactly one
  listener.
- Any opt-in admin exposure on prod — explicitly rejected for now.
