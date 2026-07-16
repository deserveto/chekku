# Operations Guide

## Local setup

```bash
npm ci
cp agent/.env.example agent/.env
cp client/.env.example client/.env.local
npm run dev:sh
```

The launcher provisions local Garage configuration, waits for Garage health, then starts:

- Garage S3 API on `http://127.0.0.1:3900`;
- Mastra on `http://localhost:4111`;
- Next.js on `http://localhost:3000`.

It generates and exports these application values to both server processes; do not copy generated credentials into tracked files:

```text
GARAGE_ENDPOINT
GARAGE_REGION
GARAGE_BUCKET
GARAGE_ACCESS_KEY_ID
GARAGE_SECRET_ACCESS_KEY
```

## Environment files

### `agent/.env`

The Mastra CLI runs from the agent workspace, so local backend values belong in `agent/.env`.

Required model values:

```dotenv
LLM_BASE_URL=https://llm.rafiqspace.ai/v1
LLM_API_KEY=replace-with-a-real-key
LLM_DEFAULT_MODEL=qwen3.6-35b-a3b-fast
```

Optional runtime values:

```dotenv
MASTRA_TELEMETRY_DISABLED=true
LLM_DISPLAY_NAME=Rafiqspace LLM
LLM_MODELS=qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b
```

`LLM_MODELS` is a fallback list. When the endpoint exposes `GET /models`, Chekku uses the discovered IDs.

### `client/.env.local`

```dotenv
AGENT_URL=http://localhost:4111
NEXT_PUBLIC_APP_URL=http://localhost:3000
CHEKKU_LOCAL_USER_ID=local-user
AGENT_SERVICE_TOKEN=
```

`AGENT_SERVICE_TOKEN` is optional and remains server-side.

## Health and model checks

```bash
curl http://localhost:4111/healthz
curl http://localhost:4111/models
```

A configured model payload resembles:

```json
{
  "configured": true,
  "displayName": "Rafiqspace LLM",
  "defaultModel": "openai-compatible/gateway/qwen3.6-35b-a3b-fast",
  "models": [
    "openai-compatible/gateway/qwen3.6-35b-a3b-fast",
    "openai-compatible/gateway/qwen3.6-35b-a3b"
  ]
}
```

## Querying endpoint models directly

Use the server-side key locally and do not paste it into tickets or chat logs:

```bash
curl \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Accept: application/json" \
  "$LLM_BASE_URL/models"
```

Set `LLM_DEFAULT_MODEL` to an exact returned `id`, without adding Chekku's internal gateway prefix.

## Storage

The default storage URL is:

```dotenv
DATABASE_URL=file:./mastra.db
```

With `npm run dev --workspace agent`, the database normally appears under `agent/`. Tooling may create it at the repository root when tests or scripts import the runtime from there.

Before resetting data, stop the agent process and back up any database you need.

```bash
find . -maxdepth 2 -name 'mastra.db*' -print
```

Reset local state:

```bash
rm -f agent/mastra.db agent/mastra.db-wal agent/mastra.db-shm
rm -f mastra.db mastra.db-wal mastra.db-shm
```

This removes stored agents and conversation history.

### Garage object storage

Local Garage runs image `dxflrs/garage:v2.3.0` with persistent Docker volumes and generic bucket `chekku-objects`. Compose publishes only the S3 API at `127.0.0.1:3900`; RPC, admin, and metrics ports stay inside the Docker network. Stop application processes before changing credentials. To stop Garage without deleting its volumes:

```bash
docker compose --env-file storage/.env.local down
```

Do not commit or paste contents from `storage/.env.local`, `storage/.garage/`, or generated `agent/.env.development`. Removing Garage volumes destroys local agent objects and is intentionally not part of normal reset instructions.

Garage MCP validates relative keys before access, limits keys to 512 UTF-8 bytes, limits text to 262,144 UTF-8 bytes, and returns at most 100 list entries. Physical objects are isolated under `agents/<base64url-agent-id>/`; tool callers see relative keys only. Replace and delete require user approval.

Garage v2.3.0 does not process destination `If-Match`/`If-None-Match` headers for PUT or DELETE. The adapter serializes same-key mutations in one process and performs an immediate existence check; it also sends `If-None-Match` on create for S3 providers that support it. This prevents stale races among calls through one adapter instance, but an external writer can still race a Garage mutation. Do not claim cross-process compare-and-swap semantics until the pinned Garage release supports those conditions.

### PM report objects

PM Agent tools and Next.js server report services share the fixed `pm-agent` namespace. Logical report objects are:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

Metadata contains these relative keys only. Do not expose or manually construct physical `agents/<base64url-agent-id>/...` keys. No migration reads old global development objects; reports outside the fixed namespace remain invisible.

Generated IDs and all repository, PM tool, and public report boundaries use `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>`, such as `pmr_20260715112642_e720cebd`. Values outside `^pmr_[0-9]{14}_[0-9a-f]{8}$` are rejected before direct reads, and noncanonical stored metadata is excluded from lists. No migration or compatibility fallback is provided.

Report interfaces:

- `/reports` lists report ID, created time, risk rating, and status newest first.
- `/reports/[reportId]` renders saved analysis, metadata, then original weekly input.
- `GET /api/storage/pm-reports` returns `{ reports }` after server identity validation.
- `GET /api/storage/pm-reports/[reportId]` returns input, analysis, and metadata after identity and ID validation.

All four report interfaces call `client/src/server/pm-reports.ts` directly in the Next.js server and use the temporary server-side `CHEKKU_LOCAL_USER_ID` seam. They do not pass through Mastra. Chat PM tool calls separately pass through `/api/agent/*` and Mastra. Browser code never contacts Garage. Missing identity returns 403; invalid IDs return 400 or page not-found; missing reports return 404; storage failures return bounded 503 responses without provider details.

When PM Agent lists reports in chat, its code-defined list tool generates a deterministic GFM table and the agent returns it unchanged. Rows contain URL-encoded relative report links, compact UTC timestamps, ratings, and statuses. Links open in a new tab with `rel="noreferrer"`. Chat and `/reports` tables are labeled keyboard-focusable regions with visible focus styles and horizontal scrolling on narrow screens. Empty lists return `No saved reports found.` exactly; invalid stored timestamps remain visible rather than breaking the list.

PM report tools are not exposed by Garage MCP. Generic stored-agent Garage access remains exactly `create_text_object`, `get_text_object`, `list_text_objects`, `replace_text_object`, and `delete_object`. Garage v2.3 external-writer race limitations above apply to PM writes as well.

## Browser operation

```dotenv
BROWSER_HEADLESS=true
```

Set it to `false` during local debugging when a visible browser is useful. The QA Web Agent keeps Memory enabled and may request approval for interactive browser actions.

Browser automation can fail when a site:

- blocks automated Chromium sessions;
- requires a user login or CAPTCHA;
- restricts network access;
- uses unsupported browser features.

Report the blocker rather than bypassing access controls.

## Telegram channel (social-media-agent)

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_MODE=polling
```

Create a bot with [@BotFather](https://t.me/BotFather) and paste its token. `TELEGRAM_MODE`:

- `polling` (default) — long-polls `getUpdates`; works behind a firewall and needs no public URL. Use for local dev.
- `webhook` — receives updates at a public URL; requires `TELEGRAM_WEBHOOK_SECRET_TOKEN` and a reachable deployment.
- `auto` — let the adapter choose based on runtime signals.

Slash commands (`/help`, `/roles`, `/role`, `/switch`) are registered on the Chat SDK after Mastra initializes the agent's channels (see `agent/src/mastra/index.ts`). The active role is in-memory and resets on restart.

## Email outbound (send-email tool)

```dotenv
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

Get a key at [resend.com](https://resend.com). The default `onboarding@resend.dev` sender can only deliver to the account owner; production should use a Resend-verified domain in `RESEND_FROM_EMAIL`. Every delivery requires approval. The tool fails with a clear error when `RESEND_API_KEY` is missing.

## Common failures

### Garage MCP reports missing identity

`Agent identity is required.` means execution did not include trusted `context.agent.agentId`. Do not add an agent ID to tool input. Ensure the tool runs through a hydrated Mastra agent with the built-in `garage` MCP server.

### PM report is unavailable

Confirm the report ID uses canonical public format and all five `GARAGE_*` values reach both agent and Next.js server processes. PM Agent can save through the agent process while `/reports` still fails if the client server lacks Garage configuration. Do not copy generated credentials into tracked files or bypass the fixed `pm-agent` namespace.

### Garage object storage is not configured

Confirm all five `GARAGE_*` application values are available to the agent process. For local development, rerun `npm run dev:sh`; do not hand-copy generated credentials into tracked files.

### Garage is unavailable

Check Docker and local health without exposing environment values:

```bash
docker compose --env-file storage/.env.local ps garage
docker inspect --format '{{.State.Health.Status}}' "$(docker compose --env-file storage/.env.local ps -q garage)"
```

### Model access denied

Example:

```text
key not allowed to access model
```

The endpoint and key are valid, but the model ID is not permitted. Query `/models`, choose an allowed ID, update `LLM_DEFAULT_MODEL`, and restart.

### System message ordering

Example:

```text
System message must be at the beginning
```

Verify that `OpenAICompatibleGateway.resolveLanguageModel()` wraps both `doGenerate` and `doStream` with `normalizeSystemMessages()`. Run:

```bash
npx vitest run agent/src/mastra/gateways/system-message-normalizer.test.ts
```

Then create a fresh QA thread.

### Stored agent uses an unavailable old model

The client migrates stored models against the `/models` registry before chat. Confirm:

```bash
npx vitest run client/src/lib/stored-agent-migration.test.ts
```

If the database contains obsolete local experiments and no data must be preserved, reset the database.

### Agent histories appear mixed

Run:

```bash
npx vitest run client/src/lib/thread-id.test.ts client/src/server/thread-ownership.test.ts client/src/lib/memory-threads.test.ts
```

Do not remove the agent/resource prefix or ownership guard.

### Next.js route not found after copying files

Dynamic folders contain literal brackets. Confirm they exist exactly, clear the cache, and restart:

```bash
rm -rf client/.next
npm run dev
```

### Mastra dev exits with `Non-representable type encountered: optional`

Chekku pins `zod` to `3.25.76`. Mastra development OpenAPI generation currently fails when the application resolves its schemas through Zod 4. Confirm the installed tree and reinstall from the root lockfile:

```bash
npm ls zod
rm -rf node_modules agent/node_modules client/node_modules
npm ci
```

Do not independently upgrade the agent workspace to Zod 4 without first proving `npm run dev:agent` and the schema compatibility test.

### Build cannot reach the npm registry

`mastra build` creates a standalone server bundle and installs that bundle's production dependencies. The build therefore needs access to the configured npm registry, even after the source workspace has already run `npm ci`. Check proxy and registry configuration, then retry:

```bash
npm config get registry
npm run build --workspace agent
```

The Next.js client uses system font stacks and does not require a Google Fonts download during production builds.

## Verification

Run before merging:

```bash
npm ci
npm run check
npm run build
git diff --check
```

The test suite covers model routing, model discovery, prompt normalization, all four built-in agents, Telegram roles and slash commands, email approval flow, PM tools and repositories, report APIs/pages and accessible tables, stored-agent payloads and Garage hydration, stored-model migration, thread ownership, proxy paths, UI structure, namespaced storage, Garage adapter safety, and launcher behavior.

## Production notes

Before deploying beyond local development:

- replace `CHEKKU_LOCAL_USER_ID` with real authentication;
- configure a deployment secret manager;
- set a durable LibSQL-compatible database URL and token;
- restrict `WEB_URL` to the deployed client origin;
- configure an authenticated server-to-server hop if the Mastra service is exposed separately;
- review browser approval and network policies;
- if the social-media-agent is enabled, set `TELEGRAM_MODE=webhook` with a public URL and `TELEGRAM_WEBHOOK_SECRET_TOKEN`, and provision a Resend-verified sender for the send-email tool;
- add rate limits, audit logging, and backup procedures appropriate to the environment.
