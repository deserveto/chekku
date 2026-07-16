<div align="center">

# Chekku

**A local-first agent studio for building, running, and testing Mastra agents.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Mastra](https://img.shields.io/badge/Mastra-Agent%20Runtime-6B5CE7)](https://mastra.ai/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Chekku provides a focused interface for managing agents, creating agent-specific conversations, analyzing engineering weekly reports, and running browser-assisted QA through a provider-neutral OpenAI-compatible model gateway. Three npm workspaces provide the Next.js client, Mastra server, and shared Garage/S3 object-storage package. LibSQL remains the local source of truth for agents and conversations; Garage stores generic agent objects and PM report artifacts.

## Highlights

- **Agent Studio** — browse code-defined and stored agents from one registry.
- **Stored-agent builder** — create, edit, delete, and hydrate agents through `@mastra/editor`.
- **Agent-isolated history** — each agent owns its own Memory threads and conversation list.
- **OpenAI-compatible models** — connect Rafiqspace LLM, LiteLLM, vLLM, or another compatible endpoint with server-only credentials.
- **Browser QA agent** — navigate and inspect live websites using Mastra Agent Browser.
- **PM Agent reports** — analyze weekly reports, save risk reviews in Garage, and browse linked report details.
- **Hosted-vLLM compatibility** — final prompt normalization keeps system messages at the beginning.
- **Local-first storage** — agent definitions, versions, memory, and threads live in LibSQL.
- **Agent-isolated Garage storage** — stored agents can opt into five generic UTF-8 text-object tools backed by a local Garage bucket.
- **Same-origin client traffic** — browser requests go through the Next.js proxy instead of calling the Mastra server directly.

## Architecture

```text
Browser
  │
  ▼
Next.js client :3000
  │  /api/agent/*
  │  same-origin server proxy
  ▼
Mastra server :4111
  ├── main-agent
  ├── pm-agent ──► code-defined PM report tools
  ├── qa-web-agent
  ├── @mastra/editor stored agents
  ├── Mastra Memory
  ├── calculator + current-time tools
  ├── Garage MCP (optional stored-agent capability)
  │       │
  │       ▼
  │   @chekku/storage ──► Garage/S3 bucket
  ├── PM report repository ──► fixed pm-agent namespace
  └── OpenAI-compatible gateway
          │
          ▼
  Rafiqspace LLM / LiteLLM / vLLM / compatible endpoint

LibSQL stores agent definitions, versions, memory, and threads.
```

See [Architecture](docs/ARCHITECTURE.md) for the runtime boundaries and data flow.

## Prerequisites

- **Node.js 22.22 or newer**
- **npm 10 or newer**
- An API key for an OpenAI-compatible endpoint
- A Chromium-compatible environment for browser-agent workflows

> The repository pins Node.js 22.22 in `.nvmrc` so local development and CI use the same supported runtime.

## Quick start

### 1. Install dependencies

```bash
npm ci
```

### 2. Configure the Mastra server

```bash
cp agent/.env.example agent/.env
```

Edit `agent/.env`:

```dotenv
LLM_BASE_URL=https://llm.rafiqspace.ai/v1
LLM_API_KEY=replace-with-your-server-only-key
LLM_DEFAULT_MODEL=qwen3.6-35b-a3b-fast
LLM_DISPLAY_NAME=Rafiqspace LLM
LLM_MODELS=qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b
```

Never expose `LLM_API_KEY` through a `NEXT_PUBLIC_*` variable or commit `agent/.env`.

### 3. Configure the client

```bash
cp client/.env.example client/.env.local
```

The defaults target the local Mastra server and normally require no edits.

### 4. Start the application

For client and agent development without local Garage orchestration:

```bash
npm run dev
```

For client, agent, and local Garage together, use Git Bash, WSL, or another Bash environment with Docker Compose:

```bash
npm run dev:sh
```

`dev:sh` creates private ignored Garage credentials and configuration, exposes the `chekku-objects` S3 API only at `127.0.0.1:3900`, waits for health, writes the five application Garage values to ignored `agent/.env.development`, then starts client and agent processes. It uses tmux when available and otherwise gives process groups a bounded TERM grace period before KILL.

Open:

- Studio: `http://localhost:3000`
- Reports: `http://localhost:3000/reports`
- Mastra health: `http://localhost:4111/healthz`
- Model registry: `http://localhost:4111/models`

## Environment

### Agent server

Local file: `agent/.env`

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `4111` | Mastra HTTP port. |
| `HOST` | No | `localhost` | Mastra bind host. |
| `DATABASE_URL` | No | `file:./mastra.db` | LibSQL database URL. |
| `DATABASE_AUTH_TOKEN` | No | empty | Auth token for remote LibSQL-compatible storage. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |
| `MASTRA_TELEMETRY_DISABLED` | No | unset | Set to `true` to disable Mastra CLI telemetry. |
| `WEB_URL` | No | `http://localhost:3000` | Allowed client origin. |
| `LLM_BASE_URL` | Yes | empty | OpenAI-compatible API base ending in `/v1`. |
| `LLM_API_KEY` | Yes | empty | Server-only endpoint credential. |
| `LLM_DEFAULT_MODEL` | Yes | empty | Endpoint-native model ID. |
| `LLM_DISPLAY_NAME` | No | `OpenAI-compatible endpoint` | Label shown in the studio. |
| `LLM_MODELS` | No | empty | Comma-separated fallback model IDs. |
| `CHEKKU_DEFAULT_AGENT_ID` | No | `main-agent` | Default agent for new sessions. |
| `CHEKKU_LOCAL_USER_ID` | No | `local-user` | Development identity and Memory resource ID. |
| `BROWSER_HEADLESS` | No | `true` | Run the QA browser without a visible window. |
| `GARAGE_ENDPOINT` | For Garage tools | empty | Server-only S3-compatible endpoint. |
| `GARAGE_REGION` | For Garage tools | empty | Garage S3 region. |
| `GARAGE_BUCKET` | For Garage tools | empty | Generic object bucket; local launcher uses `chekku-objects`. |
| `GARAGE_ACCESS_KEY_ID` | For Garage tools | empty | Server-only Garage access key. |
| `GARAGE_SECRET_ACCESS_KEY` | For Garage tools | empty | Server-only Garage secret key. |

### Client

Local file: `client/.env.local`

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AGENT_URL` | No | `http://localhost:4111` | Server-only upstream used by the Next.js proxy. |
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:3000` | Browser-visible Next.js origin used by the Mastra client. |
| `CHEKKU_LOCAL_USER_ID` | No | `local-user` | Temporary local identity until OIDC is added. |
| `AGENT_SERVICE_TOKEN` | No | empty | Optional server-to-server bearer token. |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start agent and client workspaces together. |
| `npm run dev:sh` | Generate local Garage state, start Garage, then start agent and client. |
| `npm run dev:agent` | Start only the Mastra server. |
| `npm run dev:client` | Start only the Next.js client. |
| `npm run typecheck` | Type-check all three workspaces. |
| `npm run lint` | Run the client ESLint configuration. |
| `npm test` | Run all Vitest tests. |
| `npm run check` | Run typecheck, lint, and tests. |
| `npm run build` | Build Mastra and Next.js for production. |

The client uses system font stacks, so `next build` does not download fonts from Google. Mastra production builds still install the generated server bundle dependencies and therefore require access to the configured npm registry.

## Repository layout

```text
.
├── agent/                  # Mastra server and agent runtime
│   └── src/
│       ├── agents/         # main-agent, pm-agent, and qa-web-agent
│       ├── config/         # environment and middleware
│       ├── mastra/
│       │   ├── gateways/   # OpenAI-compatible gateway and normalization
│       │   ├── processors/ # browser/tool compatibility
│       │   ├── routes/     # /healthz and /models
│       │   └── tools/      # stored-agent and code-defined PM tools
│       └── providers/      # model configuration helpers
├── client/                 # Next.js studio
│   └── src/
│       ├── app/            # routes and same-origin proxy
│       ├── components/     # agent catalog, builder, chat, shared UI
│       ├── lib/            # Mastra client, models, agents, threads
│       └── server/         # auth seam, proxy validation, payload helpers
├── storage/                # generic Garage/S3 storage plus PM report repository
├── scripts/                # local Garage environment and development launchers
├── docs/                   # architecture, operations, cleanup history
└── .github/workflows/      # CI
```

## Core rules

These rules keep the repository from drifting back into parallel implementations:

1. `agent/src/mastra/index.ts` is the backend composition root.
2. Stored-agent CRUD and hydration use `@mastra/editor`; do not add a second custom agent database.
3. Conversations use Mastra Memory; do not add separate conversation tables or routes.
4. Models use only `LLM_*` configuration through the OpenAI-compatible gateway.
5. Thread IDs must include the agent and resource prefix.
6. QA Web Agent must keep active Memory and final system-message normalization.
7. Client HTTP traffic must use `/api/agent/*` unless a protocol cannot be proxied by Next.js.
8. Garage MCP exposes only `create_text_object`, `get_text_object`, `list_text_objects`, `replace_text_object`, and `delete_object`.
9. Garage identity comes from trusted Mastra execution context, never tool input; browser code never accesses Garage directly.
10. PM report semantics stay outside Garage MCP in code-defined `pm-agent` tools and the shared report repository.
11. PM storage always binds to fixed `pm-agent`; persisted metadata contains relative `pm-reports/...` keys only.

## Garage MCP

Stored agents may select the whitelisted `garage` capability in the builder. Selection persists as `mcpClients: { garage: { tools: {} } }`; arbitrary MCP URLs, commands, packages, and credentials are rejected by the same-origin proxy before stored-agent create or update requests reach Mastra.

Garage MCP exposes exactly five generic tools:

- `create_text_object` rejects a key that already exists.
- `get_text_object` reads an existing UTF-8 text object.
- `list_text_objects` returns at most 100 relative keys plus a `truncated` flag.
- `replace_text_object` replaces an existing object and requires approval.
- `delete_object` deletes an existing object and requires approval.

Garage v2.3 does not provide destination conditional PUT/DELETE semantics. Chekku serializes same-key mutations within one storage adapter instance and checks existence immediately before mutation; external Garage writers can still race these operations.

Every operation requires trusted `context.agent.agentId`. Physical keys use `agents/<base64url-agent-id>/<relative-key>`, while inputs and responses contain relative keys only. Relative keys are limited to 512 UTF-8 bytes and reject absolute paths, backslashes, traversal, control characters, and empty segments. Text is limited to 262,144 UTF-8 bytes.

Missing identity, invalid input, collisions, missing objects, configuration failures, and connectivity failures return bounded actionable errors. Provider responses, endpoints, headers, credentials, and request IDs are never copied into errors.

## PM reports

`pm-agent` is a protected code-defined agent with Memory and three private tools: `save_pm_report_to_garage`, `list_pm_reports_from_garage`, and `view_pm_report_from_garage`. These tools are registered only on PM Agent. They are not Garage MCP tools and do not change the generic five-tool contract available to stored agents.

Both PM Agent tools and `client/src/server/pm-reports.ts` bind root storage to the fixed `pm-agent` namespace. Logical objects use relative keys:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

Physical `agents/<base64url-agent-id>/...` prefixes never appear in persisted metadata, tool output, APIs, or pages. Existing global development objects are not migrated or used as fallback. Canonical public report IDs use `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>`, for example `pmr_20260715112642_e720cebd`.

Authenticated server boundaries expose `GET /api/storage/pm-reports` and `GET /api/storage/pm-reports/[reportId]`. Pages at `/reports` and `/reports/[reportId]` use the same server-only service and temporary `CHEKKU_LOCAL_USER_ID` identity seam; browser code never imports storage or contacts Garage directly. Detail pages render analysis, metadata, then original input.

Report-list tool output includes structured metadata plus presentation-only `reportUrl` and deterministic `reportsMarkdown`. PM Agent returns the generated newest-first GFM table unchanged. Valid dates render as `YYYY-MM-DD HH:mm UTC`; invalid stored text remains visible and safely escaped. Report links use URL-encoded relative paths, open in a new tab with `rel="noreferrer"`, and are not persisted. Chat and report-list tables use labeled, keyboard-focusable horizontal-scroll regions with visible focus outlines, preserving readable columns on narrow screens.

Detailed contributor constraints are in [AGENTS.md](AGENTS.md).

## Troubleshooting

### `No model configured`

Confirm these are present in `agent/.env`:

```dotenv
LLM_BASE_URL=https://your-endpoint.example/v1
LLM_API_KEY=...
LLM_DEFAULT_MODEL=exact-model-id-from-get-v1-models
```

Restart the development server after changing environment values.

### `key not allowed to access model`

Your endpoint accepted the key but rejected `LLM_DEFAULT_MODEL`. Query the endpoint's `GET /v1/models` route and copy an allowed model ID exactly.

### `System message must be at the beginning`

Chekku normalizes final model prompts in:

```text
agent/src/mastra/gateways/system-message-normalizer.ts
```

Keep that wrapper in both `doGenerate` and `doStream`. Start a fresh QA conversation after changing gateway code.

### UI requests return 404

Confirm the literal dynamic-route files exist:

```text
client/src/app/api/agent/[...path]/route.ts
client/src/app/chat/[threadId]/page.tsx
client/src/app/agents/[id]/edit/page.tsx
```

Then clear the Next.js cache and restart:

```bash
rm -rf client/.next
npm run dev
```

### Reset local agents and conversations

Stop the server, then remove the local database:

```bash
rm -f agent/mastra.db agent/mastra.db-wal agent/mastra.db-shm
```

Depending on the current working directory used by the Mastra CLI, the database may also appear at the repository root. See [Operations](docs/OPERATIONS.md) before deleting data.

## Security

- API keys belong only in `agent/.env` or a deployment secret manager.
- Never use `NEXT_PUBLIC_LLM_API_KEY` or similar browser-exposed credentials.
- Keep `.env`, local databases, logs, and browser artifacts out of commits.
- Keep generated `storage/.env.local`, `storage/.garage/`, and Garage credentials/data out of commits and logs.
- Garage is server-only. Browser components must never import `@chekku/storage` or call Garage directly.
- Browser actions that submit, publish, purchase, delete, or otherwise cause consequences require approval.
- `CHEKKU_LOCAL_USER_ID` is a development seam, not production authentication.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Cleanup manifest](docs/CLEANUP_MANIFEST.md)
- [Agentic contributor instructions](AGENTS.md)

## Contributing

1. Create a focused branch.
2. Keep changes within the active architecture.
3. Add or update tests for behavioral changes.
4. Run `npm run check` and `npm run build`.
5. Do not commit secrets, local databases, build output, or generated caches.

## License

Chekku is available under the [MIT License](LICENSE).
