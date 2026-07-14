# Operations Guide

## Local setup

```bash
npm ci
cp agent/.env.example agent/.env
cp client/.env.example client/.env.local
npm run dev
```

The root development command starts:

- Mastra on `http://localhost:4111`;
- Next.js on `http://localhost:3000`.

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

PM Agent report storage uses Garage/S3-compatible object storage:

```dotenv
GARAGE_ENDPOINT=https://garage.example.com
GARAGE_REGION=garage
GARAGE_BUCKET=chekku-pm-reports
GARAGE_ACCESS_KEY_ID=replace-with-server-only-access-key
GARAGE_SECRET_ACCESS_KEY=replace-with-server-only-secret-key
```

Garage credentials remain server-side in `agent/.env` or deployment secrets. Do not add them to `client/.env.local` or any `NEXT_PUBLIC_*` variable.

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

PM Agent weekly report analyses are separate from LibSQL. They are stored in Garage under:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

If PM Agent report save/list/view fails with `Garage storage not configured`, set all five `GARAGE_*` values in `agent/.env` and restart the agent server.

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

## Common failures

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

The test suite covers model routing, model discovery, prompt normalization, agent configuration, tools, stored-agent payloads, stored-model migration, thread ownership, proxy paths, and UI structure.

## Production notes

Before deploying beyond local development:

- replace `CHEKKU_LOCAL_USER_ID` with real authentication;
- configure a deployment secret manager;
- set a durable LibSQL-compatible database URL and token;
- restrict `WEB_URL` to the deployed client origin;
- configure an authenticated server-to-server hop if the Mastra service is exposed separately;
- review browser approval and network policies;
- add rate limits, audit logging, and backup procedures appropriate to the environment.
