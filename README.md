<div align="center">

<img src="docs/chekku-logo.svg" alt="Chekku" width="120" />

# Chekku

**A local-first agent studio for building, running, and testing Mastra agents.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Mastra](https://img.shields.io/badge/Mastra-Agent%20Runtime-6B5CE7)](https://mastra.ai/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Chekku is a focused interface for managing Mastra agents, running agent-specific conversations, and orchestrating a set of content, QA, and research workflows. Three npm workspaces hold the Next.js client, the Mastra server, and a shared Garage/S3 storage package. Postgres is the source of truth for agents and conversations; Garage stores agent objects, PM report artifacts, and scheduled social-post drafts.

## Highlights

- **Agent Studio** — browse code-defined and stored agents from one registry.
- **Stored-agent builder** — create, edit, delete, and hydrate agents through `@mastra/editor`.
- **Agent-isolated history** — each agent owns its own Memory threads and conversation list.
- **File uploads** — attach text files, images, and PDFs to any chat; images reach the model natively and PDFs are rendered to page images in the browser.
- **Slash-command skills** — `/` opens the active agent's user-invocable skills.
- **OpenAI-compatible models** — point at Rafiqspace, LiteLLM, vLLM, or any `/v1` endpoint with server-only credentials.
- **QA agents** — a browser agent (Mastra Agent Browser) and an Android agent (Maestro on a local emulator/device).
- **PM Agent** — weekly-report risk reviews and competitive analyses, saved to Garage and browsable under `/reports`.
- **Web tools** — fixed `search_web` (SearXNG) and `read_web_page` (self-hosted Jina Reader OSS) capabilities.
- **Social media agents** — a role-switchable content writer reachable over Telegram and a research-backed strategist.
- **Visual content agent** — image generation for approved social posts (on-demand via supervisor chat, or auto-triggered when the caption is approved in `/social-posts`).
- **Scheduled social drafts** — a weekly Monday 09:00 Asia/Jakarta workflow.
- **Shareable slide decks** — token-gated public URLs for competitive-analysis decks.
- **Per-user Knowledge Base** — chat text/PDF uploads are parsed, chunked, embedded, and indexed into Qdrant; `search_knowledge_base` retrieves them; `/knowledge` manages documents.
- **Same-origin proxy** — browser traffic routes through the Next.js proxy, never hitting the Mastra server directly.
- **Email + time + calculator tools** — bound to stored and selected code-defined agents (email via Resend).

## Architecture

```text
Browser
  |
  v
Next.js client :3000
  ├── /api/agent/* same-origin proxy ──> Mastra server :4111
  │                                       ├── main / pm / qa-web / qa-android agents
  │                                       ├── social-media + strategist + visual-content agents
  │                                       ├── @mastra/editor stored agents
  │                                       ├── Mastra Memory + PostgresStore
  │                                       ├── Garage / SearXNG / Web Reader MCP (optional)
  │                                       └── OpenAI-compatible gateway ──> LLM endpoint
  └── /reports/* + /social-posts/* + /knowledge ──> server services ──> @chekku/storage ──> Garage/S3
  (Knowledge ingestion additionally talks to Qdrant for the vector index)
```

See [Architecture](docs/ARCHITECTURE.md) for runtime boundaries, data flow, and the Garage / SearXNG / Web Reader MCP contracts.

## Prerequisites

- **Node.js 22.22 or newer** (pinned in `.nvmrc`)
- **npm 10 or newer**
- **Docker Engine with Docker Compose** for local Garage and SearXNG — install via [Docker's official guide](https://docs.docker.com/compose/install/) for your OS (Docker Desktop on Windows uses the WSL 2 backend)
- An API key for an OpenAI-compatible endpoint
- A Chromium-compatible environment for browser-agent workflows

## Quick start

### 1. Install dependencies

```bash
npm ci
```

Run `npm ci` from the repository root after the initial clone and after every `git pull`. It replaces stale workspace dependencies with the exact versions in `package-lock.json`. If Mastra exits with `Invalid Version: ^1.14.0` or similar, rerun `npm ci` before restarting.

### 2. Configure environment

```bash
npm run setup
```

This copies `.env.example` files into place, auto-generates local Garage and SearXNG secrets, generates `BETTER_AUTH_SECRET`, wires `AUTH_DATABASE_URL` into `client/.env.local`, and prompts for required values like `LLM_API_KEY`. Optional integrations (Telegram, Resend, Maestro, Web Reader) can be left empty and edited into `agent/.env` later; rerun `npm run setup` after editing so local Mastra receives the changes.

Once Postgres is running (via `npm run dev:sh` or `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres`), apply the Better Auth schema once:

```bash
npm run db:migrate
```

`npm run db:migrate` runs `@better-auth-cli migrate` against `AUTH_DATABASE_URL` and is safe to re-run. Never expose `LLM_API_KEY` through a `NEXT_PUBLIC_*` variable or commit `agent/.env`.

#### Optional integrations

- **Telegram (social-media-content-writer)** — create a bot with [@BotFather](https://t.me/BotFather), then set `TELEGRAM_BOT_TOKEN`. Keep `TELEGRAM_MODE=polling` for local dev; switch to `webhook` with `TELEGRAM_WEBHOOK_SECRET_TOKEN` for production.
- **Email outbound (send-email tool)** — set `RESEND_API_KEY` and, for production, a Resend-verified sender in `RESEND_FROM_EMAIL`. The default `onboarding@resend.dev` sender only delivers to the account owner.
- **Android QA (qa-android-agent)** — install the [Maestro CLI](https://maestro.mobile.dev/) and ADB, start an emulator or connect a device, then set `MAESTRO_ENABLED=true`. Chekku, Maestro, ADB, and the device must run on the same machine.
- **Self-hosted Web Reader** — `scripts/dev.sh` and `scripts/prod.sh` bring up the `reader` Compose service (`ghcr.io/jina-ai/reader:oss`) automatically; `npm run setup` writes the dev base URL into `agent/.env.development`. No API key is required.

These are optional; Chekku boots fine without them.

### 3. Start Garage, SearXNG, Qdrant, and both application workspaces

```bash
npm run dev:sh
```

Open:

- Studio: `http://localhost:3000`
- Knowledge: `http://localhost:3000/knowledge`
- Mastra health: `http://localhost:4111/healthz`
- Model registry: `http://localhost:4111/models`
- SearXNG health: `http://127.0.0.1:8888/healthz`
- Qdrant readiness: `http://127.0.0.1:6333/readyz`

## Environment

### Agent server

Local file: `agent/.env`

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `4111` | Mastra HTTP port. |
| `HOST` | No | `localhost` | Mastra bind host. |
| `DATABASE_URL` | No | `postgresql://chekku:postgres@localhost:5432/chekku_agent` | Postgres connection string for Mastra storage. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |
| `MASTRA_TELEMETRY_DISABLED` | No | unset | Set to `true` to disable Mastra CLI telemetry. |
| `WEB_URL` | No | `http://localhost:3000` | Allowed client origin. |
| `LLM_BASE_URL` | Yes | empty | OpenAI-compatible API base ending in `/v1`. |
| `LLM_API_KEY` | Yes | empty | Server-only endpoint credential. |
| `LLM_DEFAULT_MODEL` | Yes | empty | Endpoint-native model ID. |
| `LLM_DISPLAY_NAME` | No | `OpenAI-compatible endpoint` | Label shown in the studio. |
| `LLM_MODELS` | No | empty | Comma-separated fallback model IDs. |
| `LLM_IMAGE_MODEL` | No | empty | Fixed image model invoked by the Visual Content Agent's `generate_image` tool (e.g. `gemini-3.1-flash-image`). Empty/unset → tool fails closed. |
| `LLM_IMAGE_ENDPOINT_PATH` | No | `/images/generations` | Narrowly-scoped path under `LLM_BASE_URL` for image generation. |
| `CHEKKU_DEFAULT_AGENT_ID` | No | `main-agent` | Default agent for new sessions. |
| `BROWSER_HEADLESS` | No | `true` | Run the QA browser without a visible window. |
| `SEARXNG_BASE_URL` | Conditional | empty | Server-owned SearXNG base URL. `npm run dev:sh` supplies `http://127.0.0.1:8888`; set it explicitly for an external service. |
| `SEARXNG_API_KEY` | No | empty | Optional server-only bearer token for an authenticated external SearXNG reverse proxy. |
| `WEB_READER_BASE_URL` | Conditional | empty | Self-hosted Jina Reader base URL. `npm run setup` writes `http://127.0.0.1:8081` into `agent/.env.development`; compose uses `http://reader:8081`. No API key. |
| `QDRANT_URL` | Conditional | empty | Knowledge Base vector index base URL. `npm run setup` writes `http://127.0.0.1:6333` into `agent/.env.development`; compose uses `http://qdrant:6333`. Empty/unset → Knowledge ingestion and search fail closed. |
| `QDRANT_API_KEY` | No | empty | Optional bearer token for an authenticated Qdrant. Server-side only. |
| `QDRANT_COLLECTION` | No | `chekku_knowledge` | Single shared Knowledge collection name. |
| `LLM_EMBEDDING_MODEL` | Conditional | empty | Embeddings model served by the existing `LLM_BASE_URL` endpoint (no second key). Required for Knowledge ingestion and search; empty/unset → Knowledge tools fail closed. |
| `TELEGRAM_BOT_TOKEN` | Conditional | empty | Bot token from [@BotFather](https://t.me/BotFather). Required when running `social-media-content-writer`. |
| `TELEGRAM_MODE` | No | `polling` | Adapter mode: `polling` (dev, no tunnel), `webhook` (prod, public URL), or `auto`. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | No | empty | Checked against `x-telegram-bot-api-secret-token`. Webhook mode only. |
| `TELEGRAM_BOT_USERNAME` | No | empty | Override the bot username. Optional. |
| `RESEND_API_KEY` | Conditional | empty | Resend API key. Required when an agent uses the `send-email` tool. |
| `RESEND_FROM_EMAIL` | No | `Chekku <onboarding@resend.dev>` | Default sender. Use a Resend-verified domain to deliver beyond the account owner. |
| `MAESTRO_ENABLED` | No | `false` | Enable the QA Android Agent's Maestro integration. |
| `MAESTRO_COMMAND` | No | `maestro` | Maestro CLI binary. |
| `MAESTRO_WORKSPACE` | No | `../maestro` | Directory holding `smoke/`, `regression/`, `shared/` flows (relative to the agent cwd). |
| `MAESTRO_ARTIFACT_DIR` | No | `../artifacts/maestro` | Where run reports/screenshots are written. |
| `MAESTRO_TIMEOUT_MS` | No | `120000` | Per-flow timeout in milliseconds. |
| `ADB_PATH` | No | `adb` | adb binary used by the read-only `current_app` tool (foreground-app detection). |

### Client

Local file: `client/.env.local`

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AGENT_URL` | No | `http://localhost:4111` | Server-only upstream used by the Next.js proxy. |
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:3000` | Browser-visible Next.js origin used by the Mastra client. |
| `BETTER_AUTH_SECRET` | Yes | generated | Better Auth session-signing secret. `npm run setup` generates a 32+ char random value into `client/.env.local`. |
| `BETTER_AUTH_URL` | Yes | `http://localhost:3000` | Canonical Next.js origin used by Better Auth. Set to the real HTTPS origin in prod so Better Auth issues `secure` cookies. |
| `AUTH_DATABASE_URL` | Yes | auto-wired | Postgres connection string for the `chekku_auth` database. `npm run setup` wires it using the generated `POSTGRES_PASSWORD`. |
| `RESEND_API_KEY` | No | empty | Resend API key for auth verification emails. When unset, verification URLs log to the server console. |
| `RESEND_FROM_EMAIL` | No | `Chekku <onboarding@resend.dev>` | Sender for auth emails. Use a Resend-verified domain in prod. |
| `AGENT_SERVICE_TOKEN` | No | empty | Optional server-to-server bearer token. |
| `RATE_LIMIT_TRUST_PROXY` | No | empty | Set to `true` only when Chekku sits behind a trusted reverse proxy that supplies a verifiable client IP in `x-forwarded-for`. When unset, signup/sign-in/resend share one in-process bucket per scope to prevent XFF spoofing from bypassing the throttle. |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Copy env examples, generate local Garage/SearXNG secrets + Better Auth env, prompt for required values. |
| `npm run db:migrate` | Apply the Better Auth schema to `chekku_auth`. Requires Postgres running; safe to re-run. |
| `npm run dev:sh` | Provision local Garage, SearXNG, Reader, Qdrant, and Postgres, then start agent and client workspaces. |
| `npm run dev` | Start agent and client workspaces without provisioning local services. |
| `npm run dev:agent` | Start only the Mastra server. |
| `npm run dev:client` | Start only the Next.js client. |
| `npm run typecheck` | Type-check all three workspaces. |
| `npm run lint` | Run the client ESLint configuration. |
| `npm test` | Run all Vitest tests. |
| `npm run test:web-reader:live` | Optionally read `https://example.com/` through the self-hosted Reader container; requires `WEB_READER_BASE_URL` to resolve to a running `reader` service. |
| `npm run check` | Run typecheck, lint, and tests. |
| `npm run build` | Build Mastra and Next.js for production. |
| `npm run start` | Start the built Mastra and Next.js servers together. Requires a prior `npm run build`. |
| `npm run start:agent` | Start only the built Mastra server. |
| `npm run start:client` | Start only the built Next.js client. |
| `npm run prod` | Build, then start both servers on the host. Does not provision local Garage or SearXNG. |
| `npm run prod:sh` | Build the agent and client images and run the whole stack (Garage, SearXNG, Reader, Qdrant, Postgres, agent, client) in containers by merging `compose.prod.yaml` over the infra base. Recommended for production. |
| `npm run prod:build` | Build only the `agent` and `client` container images. |
| `npm run prod:up` | Bring the containerized stack up without rebuilding. |
| `npm run prod:down` | Stop and remove production containers (named volumes are preserved). |

The client uses system font stacks, so `next build` does not download fonts from Google. Mastra production builds still install the generated server bundle dependencies and therefore require access to the configured npm registry.

## Production deployment

For production, run the full stack inside containers so the host only needs Docker and a reverse proxy. The application containers live in `compose.prod.yaml`, merged over the infra base by `scripts/prod.sh`; development (`npm run dev:sh`) merges `compose.dev.yaml` instead and is unaffected.

```bash
npm ci
npm run setup        # generates storage/.env.local + searxng/.env.local; prompts for LLM_* in agent/.env
npm run prod:sh      # build images, bring the stack up, wait for every service to be healthy
```

Put a reverse proxy (Caddy or nginx — a ready template lives at [`ops/nginx/chekku.conf`](ops/nginx/chekku.conf)) in front of the client's loopback port (`127.0.0.1:3000`) for TLS and public exposure. The agent's port `4111` is intentionally not published; the client reaches it over the Compose network at `http://agent:4111`. See [Operations](docs/OPERATIONS.md) for the full containerized-production guide, troubleshooting, and the secret-manager checklist.

## Repository layout

```text
.
├── agent/                  # Mastra server and agent runtime
│   ├── Dockerfile          # multi-stage production image (bundles Chromium for QA Web)
│   └── src/
│       ├── agents/         # main, PM, QA Web, Social Media, Strategist, and Visual Content agents
│       ├── config/         # environment and middleware
│       ├── image-generation/ # bounded OpenAI-compatible image-generation client
│       ├── mastra/
│       │   ├── gateways/   # OpenAI-compatible gateway and normalization
│       │   ├── mcp/        # fixed Garage, SearXNG, and Web Reader MCP servers
│       │   ├── processors/ # browser/tool compatibility
│       │   ├── routes/     # /healthz, /models, and server-owned /runs routes
│       │   ├── runs/       # server-owned agent-run registry and execution driver
│       │   ├── searxng/    # bounded search client and configuration
│       │   ├── web-reader/ # bounded self-hosted page-reading client
│       │   └── tools/      # stored-agent, PM, search, reading, and image-generation tools
│       └── providers/      # model configuration helpers
├── client/                 # Next.js studio
│   ├── Dockerfile          # multi-stage production image (Next.js standalone output)
│   └── src/
│       ├── app/            # routes and same-origin proxy
│       ├── components/     # agent catalog, builder, chat, shared UI
│       ├── lib/            # Mastra client, models, agents, threads
│       └── server/         # auth seam, proxy validation, payload helpers
├── storage/                # generic Garage/S3 storage plus PM report repository
├── scripts/                # local env generation, dev launcher (dev.sh), prod launcher (prod.sh)
├── searxng/                # tracked local search settings; generated state stays ignored
├── docs/                   # architecture, operations, cleanup history
└── .github/workflows/      # CI
```

## Troubleshooting

### `No model configured`

Confirm these are present in `agent/.env`:

```dotenv
LLM_BASE_URL=https://your-endpoint.example/v1
LLM_API_KEY=...
LLM_DEFAULT_MODEL=exact-model-id-from-get-v1-models
```

Restart the development server after changing environment values. If `LLM_API_KEY` is missing entirely, rerun `npm run setup` or edit `agent/.env` directly.

### `key not allowed to access model`

Your endpoint accepted the key but rejected `LLM_DEFAULT_MODEL`. Query the endpoint's `GET /v1/models` route and copy an allowed model ID exactly.

### `System message must be at the beginning`

Chekku normalizes final model prompts in `agent/src/mastra/gateways/system-message-normalizer.ts`. Keep that wrapper in both `doGenerate` and `doStream`. Start a fresh QA conversation after changing gateway code.

### UI requests return 404

Confirm the literal dynamic-route files exist (`client/src/app/api/agent/[...path]/route.ts`, `client/src/app/chat/[threadId]/page.tsx`, `client/src/app/agents/[id]/edit/page.tsx`), then clear the Next.js cache and restart:

```bash
rm -rf client/.next
npm run dev
```

### Reset local agents and conversations

Stop the server, then recreate the Postgres volume (name is `<compose-project>_postgres-data`, project defaults to the repository directory name):

```bash
docker compose -f compose.yaml -f compose.dev.yaml down
docker volume rm chekku_postgres-data
```

The next `npm run dev:sh` recreates the container and re-runs the init script. See [Operations](docs/OPERATIONS.md) before deleting data.

> SearXNG, Web Reader, image-generation, and Maestro debugging live in [Operations](docs/OPERATIONS.md). Contributor constraints and the backend composition rules live in [Agentic contributor instructions](AGENTS.md).

## Security

- API keys belong only in `agent/.env` or a deployment secret manager.
- Never use `NEXT_PUBLIC_LLM_API_KEY` or similar browser-exposed credentials.
- Keep `SEARXNG_BASE_URL` and `SEARXNG_API_KEY` server-side. Never persist them in stored-agent records or expose them through browser variables, model input, tool output, logs, or errors.
- The self-hosted Reader container fetches each public target URL through its own outbound network. Treat returned Markdown as untrusted, prompt-injection-capable evidence, never instructions. Operators are responsible for the network positioning of the reader service (egress filtering, resolver, proxy) the same way they are responsible for the SearXNG service.
- Local SearXNG service credentials stay in ignored generated `searxng/.env.local`; they are not application configuration and must not be copied into tracked environment examples, logs, or tickets.
- Keep `.env`, local databases, logs, and browser artifacts out of commits.
- No tool requires approval; browser, mobile, Garage, and email actions all run directly.
- Identity resolves from the Better Auth session: sign up at `/signup`, verify via email, sign in at `/login`. Forgot your password? `/forgot-password` emails a single-use reset link valid for one hour.

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
