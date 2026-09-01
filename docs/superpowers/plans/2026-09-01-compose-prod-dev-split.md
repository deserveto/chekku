# Compose prod/dev split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `compose.yaml` into a port-less infra base plus `compose.dev.yaml` / `compose.prod.yaml` overlays so production merges a config that publishes exactly two loopback ports (client :3000 for the reverse proxy, postgres :5432 for host-run migrations).

**Architecture:** Three Compose files, one service definition each. The base keeps the five infra services (garage, searxng, reader, qdrant, postgres) with no `ports:` at all; the dev overlay adds the five loopback publishes; the prod overlay carries the `agent`/`client` containers plus the postgres publish. `scripts/dev.sh` merges `-f compose.yaml -f compose.dev.yaml`, `scripts/prod.sh` merges `-f compose.yaml -f compose.prod.yaml`, and the `prod` Compose profile disappears. Spec: `docs/superpowers/specs/2026-09-01-compose-prod-dev-split-design.md`.

**Tech Stack:** Docker Compose (overlay merge), Bash launchers, Vitest (script tests execute the real shell scripts against a mocked `docker` binary).

## Global Constraints

- The five loopback binding lines are exact, verbatim, and never reformatted:
  - `"127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900"`
  - `"127.0.0.1:${CHEKKU_SEARXNG_HOST_PORT:-8888}:8080"`
  - `"127.0.0.1:${CHEKKU_READER_HOST_PORT:-8081}:8081"`
  - `"127.0.0.1:${CHEKKU_QDRANT_HOST_PORT:-6333}:6333"`
  - `"127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"`
  - Client publish in prod: `"127.0.0.1:${CHEKKU_CLIENT_HOST_PORT:-3000}:3000"`
- After Task 3, `compose.yaml` contains **no** indented `ports:` key and no `agent`/`client` services; no Compose file contains a `profiles:` key.
- Service names, network name (`chekku-network`), volume names, image pins, commands, healthchecks, and every `environment:` block move/migrate **verbatim**. The `${VAR:-}` defaults in the prod overlay's env blocks must survive (they keep `prod.sh down`/`build` working without secrets).
- Garage's internal ports 3901/3902/3903 must never appear in any published binding.
- Compose merge semantics: per-service lists append across files; the base has no `ports:`, so each environment gets exactly its overlay's bindings — no `!reset`/`!override` tags anywhere.
- While both base and dev overlay declare the identical garage/searxng/reader/qdrant/postgres bindings (Task 1 only), the duplicate identical bindings are harmless; they are removed from the base in Task 3.
- Tests: run from the repo root. `scripts/dev.test.ts` and `scripts/prod.test.ts` are excluded from the main vitest suite and run standalone: `npx vitest run scripts/dev.test.ts` and `npx vitest run scripts/prod.test.ts`. Every commit must leave both green.
- Toolchain: Node >= 22.22.0. Do not touch nginx config, `scripts/db-migrate.sh`, env var names, or anything outside the files listed per task.

---

### Task 1: Add `compose.dev.yaml` and `compose.prod.yaml` overlay files

The base file is untouched in this task, so the system's behavior is identical before and after: the dev overlay duplicates the bindings the base already declares (harmless), and the prod overlay duplicates the two profile-gated services (still gated by their `profiles:` keys in the base, which keep winning until Task 3).

**Files:**
- Create: `compose.dev.yaml`
- Create: `compose.prod.yaml`
- Test: `scripts/dev.test.ts` (fixture list + new static test)
- Test: `scripts/prod.test.ts` (fixture list + new static test)

**Interfaces:**
- Consumes: the exact service definitions currently in `compose.yaml` (lines 127–265 for agent/client).
- Produces: `compose.dev.yaml` and `compose.prod.yaml` with the exact contents shown below; Task 2 wires `dev.sh` to the dev pair, Task 3 wires `prod.sh` to the prod pair and strips the base.

- [ ] **Step 1: Write the failing static tests**

In `scripts/dev.test.ts`, inside the existing `describe('committed local runtime', ...)` block, add a new test after the first one:

```ts
  it('dev overlay publishes exactly the five loopback infra ports', () => {
    const devOverlay = readFileSync(resolve(sourceRoot, 'compose.dev.yaml'), 'utf8');
    expect(devOverlay).toContain('"127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900"');
    expect(devOverlay).toContain('"127.0.0.1:${CHEKKU_SEARXNG_HOST_PORT:-8888}:8080"');
    expect(devOverlay).toContain('"127.0.0.1:${CHEKKU_READER_HOST_PORT:-8081}:8081"');
    expect(devOverlay).toContain('"127.0.0.1:${CHEKKU_QDRANT_HOST_PORT:-6333}:6333"');
    expect(devOverlay).toContain('"127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"');
    expect(devOverlay).toMatch(/^[ \t]+ports:/m);
    expect(devOverlay).not.toContain('profiles:');
    const published = devOverlay.match(/- "127\.0\.0\.1:[^"]+"/g) ?? [];
    expect(published).toHaveLength(5);
    for (const internal of [3901, 3902, 3903]) {
      expect(devOverlay).not.toMatch(new RegExp(`^[^#]*${internal}:${internal}`, 'm'));
    }
  });
```

Also add `'compose.dev.yaml'` to the fixture copy list (the array that already contains `'compose.yaml'`, around line 97).

In `scripts/prod.test.ts`, add a new top-level `describe` block:

```ts
describe("committed production runtime", () => {
  it("prod overlay publishes only the client and postgres loopback ports", () => {
    const prod = readFileSync(resolve(sourceRoot, "compose.prod.yaml"), "utf8");
    expect(prod).toContain('"127.0.0.1:${CHEKKU_CLIENT_HOST_PORT:-3000}:3000"');
    expect(prod).toContain('"127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"');
    expect(prod).toMatch(/^[ \t]+ports:/m);
    expect(prod).not.toContain("profiles:");
    const published = prod.match(/- "127\.0\.0\.1:[^"]+"/g) ?? [];
    expect(published).toHaveLength(2);
    for (const internal of [":3900:", ":8888:", ":8081:", ":6333:"]) {
      expect(prod).not.toContain(internal);
    }
    for (const leaked of [3901, 3902, 3903]) {
      expect(prod).not.toMatch(new RegExp(`^[^#]*${leaked}:${leaked}`, "m"));
    }
  });
});
```

Also add `"compose.prod.yaml"` to the prod fixture copy list (the array that already contains `"compose.yaml"`, around line 125). Verify both files import `readFileSync` / `resolve` already (they do — existing tests use them).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run scripts/dev.test.ts 2>&1 | tail -5
npx vitest run scripts/prod.test.ts 2>&1 | tail -5
```

Expected: each run reports exactly one failing test (ENOENT for the missing overlay file); all pre-existing tests pass.

- [ ] **Step 3: Create `compose.dev.yaml`**

```yaml
# Development overlay: publishes the infra services on loopback so the
# host-run agent and client (scripts/dev.sh) and host tools (db-migrate.sh)
# can reach them. Always merged over the base file:
#   docker compose -f compose.yaml -f compose.dev.yaml ...
# or simply use scripts/dev.sh, which passes this pair on every invocation.
# Production (scripts/prod.sh) never merges this file; its only loopback
# publishes are the client and postgres (see compose.prod.yaml).
services:
  garage:
    ports:
      - "127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900"
  searxng:
    ports:
      - "127.0.0.1:${CHEKKU_SEARXNG_HOST_PORT:-8888}:8080"
  reader:
    ports:
      - "127.0.0.1:${CHEKKU_READER_HOST_PORT:-8081}:8081"
  qdrant:
    ports:
      - "127.0.0.1:${CHEKKU_QDRANT_HOST_PORT:-6333}:6333"
  postgres:
    ports:
      - "127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"
```

- [ ] **Step 4: Create `compose.prod.yaml`**

Copy the `agent` and `client` service blocks verbatim out of `compose.yaml` (lines 127–265), dropping each service's `profiles: [prod]` line and the "Application services are opt-in via the `prod` profile" block comment (lines 120–126), and prepend this header. The result must be exactly:

```yaml
# Production overlay: the application containers, merged over the infra base.
# Always invoked as:
#   docker compose -f compose.yaml -f compose.prod.yaml ...
# or through scripts/prod.sh, which passes this pair on every invocation and
# fails closed on missing production values. Development never merges this
# file (scripts/dev.sh pairs the base with compose.dev.yaml instead). The
# merged production config publishes exactly two loopback ports: the client
# (for the reverse proxy) and postgres (for host-run migrations/backups).
services:
  agent:
    build:
      context: .
      dockerfile: agent/Dockerfile
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      garage:
        condition: service_healthy
      searxng:
        condition: service_healthy
      reader:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 4111
      LOG_LEVEL: ${LOG_LEVEL:-info}
      MASTRA_TELEMETRY_DISABLED: ${MASTRA_TELEMETRY_DISABLED:-true}
      WEB_URL: ${WEB_URL:-http://localhost:3000}
      # Postgres lives on the Compose default network under service name `postgres`.
      DATABASE_URL: postgresql://chekku:${POSTGRES_PASSWORD:-postgres}@postgres:5432/chekku_agent
      # Single OpenAI-compatible model gateway (server-only credentials).
      LLM_BASE_URL: ${LLM_BASE_URL:-}
      LLM_API_KEY: ${LLM_API_KEY:-}
      LLM_DEFAULT_MODEL: ${LLM_DEFAULT_MODEL:-}
      LLM_DISPLAY_NAME: ${LLM_DISPLAY_NAME:-OpenAI-compatible endpoint}
      LLM_MODELS: ${LLM_MODELS:-}
      LLM_IMAGE_MODEL: ${LLM_IMAGE_MODEL:-}
      LLM_IMAGE_ENDPOINT_PATH: ${LLM_IMAGE_ENDPOINT_PATH:-/images/generations}
      # Garage object storage. The endpoint is fixed to the in-container
      # service name (the dev-oriented 127.0.0.1:3900 from storage/.env.local
      # must NOT reach the container). Region, bucket, and credentials come
      # from storage/.env.local via the shell environment.
      GARAGE_ENDPOINT: http://garage:3900
      GARAGE_REGION: ${GARAGE_REGION:-}
      GARAGE_BUCKET: ${GARAGE_BUCKET:-}
      GARAGE_ACCESS_KEY_ID: ${GARAGE_ACCESS_KEY_ID:-}
      GARAGE_SECRET_ACCESS_KEY: ${GARAGE_SECRET_ACCESS_KEY:-}
      # SearXNG search; fixed to the in-container service (listens on 8080).
      SEARXNG_BASE_URL: http://searxng:8080
      SEARXNG_API_KEY: ${SEARXNG_API_KEY:-}
      # Self-hosted Jina Reader (OSS image); fixed to the in-container service
      # HTTP/1.1 endpoint. No API key — the local Reader is unauthenticated.
      WEB_READER_BASE_URL: http://reader:8081
      # Knowledge Base vector index (Qdrant). Fixed to the in-container
      # service name. LLM_EMBEDDING_MODEL must be set for ingestion and
      # retrieval to work; empty keeps every KB tool failing closed.
      QDRANT_URL: http://qdrant:6333
      QDRANT_API_KEY: ${QDRANT_API_KEY:-}
      QDRANT_COLLECTION: ${QDRANT_COLLECTION:-chekku_knowledge}
      LLM_EMBEDDING_MODEL: ${LLM_EMBEDDING_MODEL:-}
      PUBLIC_HOLIDAY_API_BASE_URL: ${PUBLIC_HOLIDAY_API_BASE_URL:-https://api-hari-libur.vercel.app/api}
      CHEKKU_DEFAULT_AGENT_ID: ${CHEKKU_DEFAULT_AGENT_ID:-main-agent}
      CHEKKU_LOCAL_USER_ID: ${CHEKKU_LOCAL_USER_ID:-local-user}
      BROWSER_HEADLESS: ${BROWSER_HEADLESS:-true}
      # Optional integrations (empty is safe; the server boots without them).
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_MODE: ${TELEGRAM_MODE:-webhook}
      TELEGRAM_BOT_USERNAME: ${TELEGRAM_BOT_USERNAME:-}
      TELEGRAM_WEBHOOK_SECRET_TOKEN: ${TELEGRAM_WEBHOOK_SECRET_TOKEN:-}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      RESEND_FROM_EMAIL: ${RESEND_FROM_EMAIL:-Chekku <onboarding@resend.dev>}
      SOCIAL_DRAFT_REVIEW_EMAIL: ${SOCIAL_DRAFT_REVIEW_EMAIL:-}
      # Maestro (QA Android) stays host/device-only; never enabled in-container.
      MAESTRO_ENABLED: "false"
    # No published ports: the agent is reached only by the client over the
    # Compose default network (AGENT_URL=http://agent:4111).
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4111/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 15s

  client:
    build:
      context: .
      dockerfile: client/Dockerfile
      # NEXT_PUBLIC_APP_URL is inlined by `next build`, so it must reach the
      # builder stage as an arg (the runtime `environment:` below is not enough
      # for client-bundle values). Operator sets it in client/.env.local.
      args:
        NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL:-http://localhost:3000}
    restart: unless-stopped
    depends_on:
      agent:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      HOSTNAME: 0.0.0.0
      # Same-origin proxy targets the agent by its Compose service name.
      AGENT_URL: http://agent:4111
      NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL:-http://localhost:3000}
      CHEKKU_LOCAL_USER_ID: ${CHEKKU_LOCAL_USER_ID:-local-user}
      AGENT_SERVICE_TOKEN: ${AGENT_SERVICE_TOKEN:-}
      # The Next.js server reads Garage objects for /reports/* and /social-posts/*
      # through @chekku/storage, so it needs the same Garage credentials as agent.
      # Endpoint is fixed to the in-container service name (see agent service).
      GARAGE_ENDPOINT: http://garage:3900
      GARAGE_REGION: ${GARAGE_REGION:-}
      GARAGE_BUCKET: ${GARAGE_BUCKET:-}
      GARAGE_ACCESS_KEY_ID: ${GARAGE_ACCESS_KEY_ID:-}
      GARAGE_SECRET_ACCESS_KEY: ${GARAGE_SECRET_ACCESS_KEY:-}
      # Better Auth (email/password + email verification). The secret and the
      # public base URL come from client/.env.local through scripts/prod.sh.
      # BETTER_AUTH_URL must match the browser-facing origin or verification
      # links and session cookies break.
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-}
      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3000}
      # Fixed to the in-container service name, exactly like the agent's
      # DATABASE_URL above. AUTH_DATABASE_URL in client/.env.local keeps its
      # 127.0.0.1 form because scripts/db-migrate.sh runs the Better Auth CLI
      # on the host; that value must NOT reach the container.
      AUTH_DATABASE_URL: postgresql://chekku:${POSTGRES_PASSWORD:-postgres}@postgres:5432/chekku_auth
      # Verification email transport. Without a key the link is only logged to
      # this container's stdout, so nobody can finish signup.
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      RESEND_FROM_EMAIL: ${RESEND_FROM_EMAIL:-Chekku <onboarding@resend.dev>}
      # Set to "true" only behind a reverse proxy that supplies a trustworthy
      # x-forwarded-for; otherwise all anonymous auth traffic shares one bucket.
      RATE_LIMIT_TRUST_PROXY: ${RATE_LIMIT_TRUST_PROXY:-}
    ports:
      # Loopback only; put a reverse proxy (Caddy/nginx) in front for TLS and
      # public exposure. The host port is overridable for machines where 3000 is
      # already taken; the container port stays 3000.
      - "127.0.0.1:${CHEKKU_CLIENT_HOST_PORT:-3000}:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 8s

  postgres:
    # Loopback publish for host-run maintenance: scripts/db-migrate.sh (the
    # Better Auth CLI) and pg_dump reach Postgres through the 127.0.0.1:5432
    # AUTH_DATABASE_URL form. A loopback binding is not a provisioned public
    # port; the only public surface remains the client behind the reverse
    # proxy. The host port is overridable; containers always talk to
    # postgres:5432.
    ports:
      - "127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run scripts/dev.test.ts 2>&1 | tail -3
npx vitest run scripts/prod.test.ts 2>&1 | tail -3
```

Expected: all pass. The new overlays are inert this commit (nothing merges them yet).

- [ ] **Step 6: Commit**

```bash
git add compose.dev.yaml compose.prod.yaml scripts/dev.test.ts scripts/prod.test.ts
git commit -m "feat(compose): add dev and prod overlay files"
```

---

### Task 2: Route `scripts/dev.sh` through the dev overlay

**Files:**
- Modify: `scripts/dev.sh` (4 compose invocation sites + 1 error message + 1 new array)
- Test: `scripts/dev.test.ts` (3 exact-string assertions + 1 new launcher assertion)

**Interfaces:**
- Consumes: `compose.dev.yaml` (Task 1).
- Produces: `DEV_COMPOSE` array in `dev.sh` expanding to `compose --env-file storage/.env.local -f compose.yaml -f compose.dev.yaml`; every docker-compose log line in the mocked tests carries that exact flag sequence.

- [ ] **Step 1: Write the failing tests**

In `scripts/dev.test.ts`, replace the three exact assertions (~lines 382–384):

```ts
    expect(successCalls).toContain(
      'compose --env-file storage/.env.local -f compose.yaml -f compose.dev.yaml ps -q garage',
    );
    expect(successCalls).toContain(
      'compose --env-file storage/.env.local -f compose.yaml -f compose.dev.yaml ps -q searxng',
    );
    expect(successCalls).toContain(
      'compose --env-file storage/.env.local -f compose.yaml -f compose.dev.yaml ps -q postgres',
    );
```

In the `describe('committed local runtime', ...)` block's first test, add (the `launcher` variable already reads `scripts/dev.sh`):

```ts
    expect(launcher).toContain('-f compose.yaml -f compose.dev.yaml');
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run scripts/dev.test.ts 2>&1 | tail -5
```

Expected: the launcher-flow test fails on the new exact strings; all else passes.

- [ ] **Step 3: Implement the `DEV_COMPOSE` array in `scripts/dev.sh`**

Immediately after the `docker compose version` availability check (after line 29), add:

```bash
# Every Compose invocation merges the port-less infra base with the dev
# overlay: the overlay is what publishes the loopback ports the host-run
# agent, client, and migration CLI reach services through.
DEV_COMPOSE=(docker compose --env-file storage/.env.local -f compose.yaml -f compose.dev.yaml)
```

Then replace the four inline invocations:

Line ~60 (config validation):

```bash
if ! "${DEV_COMPOSE[@]}" config --quiet >/dev/null 2>&1; then
  echo "Local services Compose configuration is invalid. Check compose.yaml, compose.dev.yaml, and generated service configuration." >&2
  exit 1
fi
```

Line ~186 (first `ps -q` inside `ensure_service_ready`):

```bash
  service_id="$(run_with_timeout "$ready_timeout_seconds" "${DEV_COMPOSE[@]}" ps -q "$service")"
```

Line ~208 (the `up` invocation):

```bash
  if ! "${DEV_COMPOSE[@]}" "${start_args[@]}"; then
```

Line ~227 (second `ps -q` inside the readiness loop):

```bash
    service_id="$(run_with_timeout "$remaining_seconds" "${DEV_COMPOSE[@]}" ps -q "$service")"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run scripts/dev.test.ts 2>&1 | tail -3
```

Expected: all pass, including the `up -d --force-recreate garage` ordering test (substring assertions survive the added flags because the flags precede the `up` subcommand).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev.sh scripts/dev.test.ts
git commit -m "chore(compose): route dev launcher through the dev overlay"
```

---

### Task 3: Route `scripts/prod.sh` through the prod overlay; strip the base file

This is the task where `compose.yaml` reaches its final form: infra definitions only, zero `ports:`. After this commit, no Compose file has a `profiles:` key and both launchers are the only supported entry points.

**Files:**
- Modify: `scripts/prod.sh` (header comment, `COMPOSE` array, error message)
- Modify: `compose.yaml` (remove 5 `ports:` blocks + the agent/client services)
- Test: `scripts/prod.test.ts` (rewrite profile test)
- Test: `scripts/dev.test.ts` (move port assertions off the base, add negative)

**Interfaces:**
- Consumes: `compose.prod.yaml` (Task 1).
- Produces: every non-`version` prod compose invocation carries `--env-file storage/.env.local -f compose.yaml -f compose.prod.yaml`; `compose.yaml` contains no indented `ports:` key.

- [ ] **Step 1: Write the failing tests**

In `scripts/prod.test.ts`, replace the test `it("always activates the prod profile and the storage env-file", ...)` (~line 285) with:

```ts
  it("always merges the prod overlay and the storage env-file", () => {
    const root = fixture();
    const result = runProd(root);
    const dockerLog = readFileSync(resolve(root, "mock-log/docker"), "utf8");

    expect(result.status, result.stderr).toBe(0);
    // Every compose invocation except the bare availability check carries the
    // env-file and both -f files, and nothing activates a profile anymore.
    for (const line of dockerLog
      .split("\n")
      .filter(
        (entry) => entry.includes("compose") && !entry.includes(" version"),
      )) {
      expect(line).toContain("--env-file storage/.env.local");
      expect(line).toContain("-f compose.yaml");
      expect(line).toContain("-f compose.prod.yaml");
      expect(line).not.toContain("--profile");
    }
  });
```

In `scripts/dev.test.ts`'s first "committed local runtime" test: delete the two port-binding assertions that read the base file (`expect(compose).toContain('"127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900"')` and `expect(compose).toContain('"127.0.0.1:${CHEKKU_SEARXNG_HOST_PORT:-8888}:8080"')` — both now covered by the Task 1 overlay test), and add:

```ts
    expect(compose).not.toMatch(/^[ \t]+ports:/m);
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run scripts/prod.test.ts 2>&1 | tail -5
npx vitest run scripts/dev.test.ts 2>&1 | tail -5
```

Expected: the prod overlay test fails on `-f compose.prod.yaml` (script still passes `--profile prod`); the dev base test fails on the negative `ports:` match (base still has them).

- [ ] **Step 3: Rewire `scripts/prod.sh`**

Header comment (lines 9–12) becomes:

```bash
# Development stays unchanged: scripts/dev.sh runs the agent and client as host
# processes and only starts the infra services. The agent and client services
# live in compose.prod.yaml, so this script is the only path that merges the
# prod overlay and brings the whole stack up as containers.
```

The `COMPOSE` array (line ~91) and its preceding comment (lines 87–90) become:

```bash
# ----- Compose invocation ---------------------------------------------------
# `--env-file storage/.env.local` keeps the infra services' ${VAR:?}
# interpolation resolving. The base + prod overlay pair is the production
# config; application values arrive via the shell environment sourced above.
COMPOSE=(docker compose --env-file storage/.env.local -f compose.yaml -f compose.prod.yaml)
```

The invalid-config message (line ~94) becomes:

```bash
    echo "Production Compose configuration is invalid. Check compose.yaml, compose.prod.yaml, and the env files." >&2
```

- [ ] **Step 4: Strip `compose.yaml` down to the port-less infra base**

Delete, exactly:
1. garage `ports:` block with its preceding comment (lines 10–17, from `ports:` through the `"127.0.0.1:${CHEKKU_GARAGE_HOST_PORT:-3900}:3900"` line).
2. searxng `ports:` block with its comment (lines 36–40).
3. reader `ports:` block with its comment (lines 63–67).
4. qdrant `ports:` block with its comment (lines 82–87).
5. postgres `ports:` block with its comment (lines 104–109).
6. The `agent:` service with its "Application services are opt-in via the `prod` profile" block comment (lines 120–204).
7. The `client:` service (lines 206–265).

The final file is: the five infra services (image/command/restart/environment/volumes/healthcheck only), then the unchanged `networks:` block (`default: name: chekku-network` with its comment), then the unchanged `volumes:` block (`garage-metadata`, `garage-data`, `searxng-cache`, `postgres-data`, `qdrant-data`).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run scripts/prod.test.ts 2>&1 | tail -3
npx vitest run scripts/dev.test.ts 2>&1 | tail -3
npm test 2>&1 | tail -5
```

Expected: script tests pass; the full suite passes (the mocked prod flow still exercises build/up/down/readiness against the mock).

- [ ] **Step 6: Real Compose validation (if Docker is available locally)**

```bash
docker compose -f compose.yaml -f compose.dev.yaml config --quiet && echo DEV-MERGE-OK
docker compose -f compose.yaml -f compose.prod.yaml --env-file storage/.env.local config --quiet && echo PROD-MERGE-OK
```

Expected: both print OK. If Docker is unavailable, note it and continue — the mock-based tests plus CI cover the contract.

- [ ] **Step 7: Commit**

```bash
git add scripts/prod.sh compose.yaml scripts/prod.test.ts scripts/dev.test.ts
git commit -m "refactor(compose): make compose.yaml the port-less infra base"
```

---

### Task 4: Update setup-env hint and all documentation

**Files:**
- Modify: `scripts/setup-env.sh:655` (migration hint)
- Modify: `README.md` (lines 84, 204)
- Modify: `docs/OPERATIONS.md` (lines 146, 272, 391, 402, 588, 591, 598–599, 614, 618, 623, 660–661, 844, 846–847, and the reset-production block)
- Modify: `docs/ARCHITECTURE.md:80`
- Modify: `AGENTS.md` (Production containerization section, lines 371–372 and the final bullet's override-hatch sentence)

**Interfaces:**
- Consumes: the flag pairs from Tasks 2–3: dev `docker compose -f compose.yaml -f compose.dev.yaml ...`, prod `docker compose -f compose.yaml -f compose.prod.yaml ...`.
- Produces: docs consistent with the split; no stale `--profile prod` reference anywhere (`grep -rn "profile prod" README.md docs AGENTS.md` returns nothing outside `docs/superpowers/`).

- [ ] **Step 1: Update `scripts/setup-env.sh`**

Line ~655:

```bash
  echo "  docker compose -f compose.yaml -f compose.dev.yaml up -d postgres && npm run db:migrate"
```

(A bare `up -d postgres` would start Postgres without its loopback publish, breaking the host-run migration.)

- [ ] **Step 2: Update README.md**

Line 84:

```markdown
Once Postgres is running (via `npm run dev:sh` or `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres`), apply the Better Auth schema once:
```

Line 204:

```markdown
For production, run the full stack inside containers so the host only needs Docker and a reverse proxy. The application containers live in `compose.prod.yaml`, merged over the infra base by `scripts/prod.sh`; development (`npm run dev:sh`) merges `compose.dev.yaml` instead and is unaffected.
```

- [ ] **Step 3: Update docs/OPERATIONS.md**

Every dev-context Compose command gains the dev `-f` pair right after `docker compose` (the infra `ps`/`logs`/`inspect` commands would technically resolve against the base alone, but standardizing prevents the recreate-drift trap where a base-only `up` silently drops the loopback publishes):

- Line 146: `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres`
- Lines 272, 402: `docker compose -f compose.yaml -f compose.dev.yaml --env-file storage/.env.local --env-file searxng/.env.local down`
- Line 391: `docker compose -f compose.yaml -f compose.dev.yaml down`
- Lines 588, 598, 599, 660, 661 (the `ps`/`logs`/`inspect` commands): insert `-f compose.yaml -f compose.dev.yaml` after `docker compose`.
- Line 591: "inspect tracked `compose.yaml`, `compose.dev.yaml`, `searxng/settings.yml`" (add the overlay to the file list).
- Lines 614, 618, 623 (inline `docker compose ps reader` / `ps qdrant`): `docker compose -f compose.yaml -f compose.dev.yaml ps reader` (and `ps qdrant`).
- Line 844: "inspect `compose.yaml`, `compose.prod.yaml`, and the local env files".
- Lines 846–847: `docker compose -f compose.yaml -f compose.prod.yaml logs agent` and `docker compose -f compose.yaml -f compose.prod.yaml ps`.
- The "Reset production data" block (~line 848): replace the "scoped to the prod profile" wording with the overlay pair:
  ```bash
  docker compose -f compose.yaml -f compose.prod.yaml down
  docker volume rm chekku_postgres-data
  ```

Also add one sentence to the "Containerized production troubleshooting" intro (after line 838's sourcing note): manual commands against the production stack merge `-f compose.yaml -f compose.prod.yaml`; manual commands during development merge `-f compose.yaml -f compose.dev.yaml`.

- [ ] **Step 4: Update docs/ARCHITECTURE.md line 80**

```markdown
`compose.yaml` is the infra base (garage, searxng, reader, qdrant, postgres) and declares no published ports; `compose.dev.yaml` adds the loopback publishes the development launcher needs, and `compose.prod.yaml` adds the `agent` and `client` containers plus the postgres loopback publish for host-run migrations. The application services use `${VAR:-}` interpolation defaults, so `scripts/prod.sh`'s `docker compose config --quiet` validation and its `down`/`build` paths still work without production secrets present. `scripts/prod.sh` merges `-f compose.yaml -f compose.prod.yaml` and is the only place that fails closed on missing required values.
```

- [ ] **Step 5: Update AGENTS.md**

Replace the first bullet of "Production containerization" (line 371) with:

```markdown
- Development and production are kept apart by Compose overlay files, not by a shared service list. `compose.yaml` is the infra base (garage, searxng, reader, qdrant, postgres) and declares no published ports; `compose.dev.yaml` adds the loopback publishes the host-run dev processes need; `compose.prod.yaml` adds the `agent` and `client` containers plus the postgres loopback publish for host-run migrations. `scripts/dev.sh` merges `-f compose.yaml -f compose.dev.yaml` on every invocation; `scripts/prod.sh` is the only path that merges `-f compose.yaml -f compose.prod.yaml` and brings the whole stack up as containers. Each service definition exists in exactly one file — never duplicate image pins, healthchecks, volumes, or port bindings across the three files.
```

Replace the second bullet's rationale clause (line 372) so it reads:

```markdown
- Application service interpolations must use `${VAR:-}` defaults (never `${VAR:?}`), so `scripts/prod.sh`'s `docker compose config --quiet` validation and its `down`/`build` paths still work without a complete production env. The only place that fails closed on missing production values is `scripts/prod.sh` (`POSTGRES_PASSWORD`, `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL`).
```

In the final bullet of the same section, replace the escape-hatch sentence "A gitignored `docker-compose.override.yaml` is the supported escape hatch for machine-specific bindings." with:

```markdown
Machine-specific Compose overrides are supplied by invoking Compose manually with an extra `-f <file>` — the scripts pass explicit `-f` lists, so an auto-loaded `docker-compose.override.yaml` is not picked up.
```

- [ ] **Step 6: Verify no stale references and run the script tests**

```bash
grep -rn "profile prod\|--profile" README.md docs/OPERATIONS.md docs/ARCHITECTURE.md AGENTS.md scripts/*.sh | grep -v superpowers || echo CLEAN
npx vitest run scripts/dev.test.ts 2>&1 | tail -3
npx vitest run scripts/prod.test.ts 2>&1 | tail -3
```

Expected: `CLEAN` (no matches), both suites green.

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-env.sh README.md docs/OPERATIONS.md docs/ARCHITECTURE.md AGENTS.md
git commit -m "docs: point every compose invocation at the dev/prod overlay files"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full check and build**

```bash
npm run check
npm run build
```

Expected: both pass (typecheck → lint → test, then builds). Use `NODE_OPTIONS=--max-old-space-size=8192` if the heap exhausts.

- [ ] **Step 2: Whitespace and final diff review**

```bash
git diff --check
git log --oneline main..
```

Expected: no whitespace errors; four commits as listed in Tasks 1–4.

- [ ] **Step 3: Report**

Summarize: files created/modified, the merged prod port surface (client :3000 + postgres :5432, both loopback), and that the public surface (nginx → 127.0.0.1:3000) is unchanged.
