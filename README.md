<div align="center">

# Chekku

**A local-first agent studio for building, running, and testing Mastra agents.**

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Mastra](https://img.shields.io/badge/Mastra-Agent%20Runtime-6B5CE7)](https://mastra.ai/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Chekku provides a focused interface for managing agents, creating agent-specific conversations, and running browser-assisted QA through a provider-neutral OpenAI-compatible model gateway. The repository contains one Next.js client and one Mastra server, with LibSQL as the local source of truth.

## Highlights

- **Agent Studio** — browse code-defined and stored agents from one registry.
- **Stored-agent builder** — create, edit, delete, and hydrate agents through `@mastra/editor`.
- **Agent-isolated history** — each agent owns its own Memory threads and conversation list.
- **OpenAI-compatible models** — connect Rafiqspace LLM, LiteLLM, vLLM, or another compatible endpoint with server-only credentials.
- **Browser QA agent** — navigate and inspect live websites using Mastra Agent Browser.
- **Social media agent** — role-switchable content assistant reachable over Telegram (X, Instagram, LinkedIn, TikTok roles).
- **Hosted-vLLM compatibility** — final prompt normalization keeps system messages at the beginning.
- **Local-first storage** — agent definitions, versions, memory, and threads live in LibSQL.
- **Same-origin client traffic** — browser requests go through the Next.js proxy instead of calling the Mastra server directly.
- **Email + time + calculator tools** — registered for stored agents and selectively bound to code-defined agents; email delivery goes through Resend.

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
   ├── qa-web-agent
   ├── social-media-agent (Telegram channel)
   ├── @mastra/editor stored agents
   ├── Mastra Memory
   ├── calculator + current-time + send-email tools
   ├── Chat SDK + Telegram adapter
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

#### Optional integrations

- **Telegram (social-media-agent)** — create a bot with [@BotFather](https://t.me/BotFather), then set `TELEGRAM_BOT_TOKEN`. Keep `TELEGRAM_MODE=polling` for local dev; switch to `webhook` with `TELEGRAM_WEBHOOK_SECRET_TOKEN` for production.
- **Email outbound (send-email tool)** — sign up at [resend.com](https://resend.com), set `RESEND_API_KEY`, and (for production) a Resend-verified sender in `RESEND_FROM_EMAIL`. The default `onboarding@resend.dev` sender only delivers to the account owner.

Both are optional; Chekku boots fine without them. The `social-media-agent` binds the send-email tool and (when configured) the Telegram channel; stored agents can opt in from the builder's **Capabilities** section.

### 3. Configure the client

```bash
cp client/.env.example client/.env.local
```

The defaults target the local Mastra server and normally require no edits.

### 4. Start both workspaces

```bash
npm run dev
```

Open:

- Studio: `http://localhost:3000`
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
| `TELEGRAM_BOT_TOKEN` | Conditional | empty | Bot token from [@BotFather](https://t.me/BotFather). Required when running `social-media-agent`. |
| `TELEGRAM_MODE` | No | `polling` | Adapter mode: `polling` (dev, no tunnel), `webhook` (prod, public URL), or `auto`. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | No | empty | Checked against `x-telegram-bot-api-secret-token`. Webhook mode only. |
| `TELEGRAM_BOT_USERNAME` | No | empty | Override the bot username. Optional. |
| `RESEND_API_KEY` | Conditional | empty | Resend API key. Required when an agent uses the `send-email` tool. |
| `RESEND_FROM_EMAIL` | No | `Chekku <onboarding@resend.dev>` | Default sender. Use a Resend-verified domain to deliver beyond the account owner. |

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
| `npm run dev:agent` | Start only the Mastra server. |
| `npm run dev:client` | Start only the Next.js client. |
| `npm run typecheck` | Type-check both workspaces. |
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
│       ├── agents/         # main-agent, qa-web-agent, social-media-agent
│       ├── config/         # environment and middleware
│       ├── mastra/
│       │   ├── gateways/   # OpenAI-compatible gateway and normalization
│       │   ├── processors/ # browser/tool compatibility
│       │   ├── routes/     # /healthz and /models
│       │   └── tools/      # stored-agent tools
│       └── providers/      # model configuration helpers
├── client/                 # Next.js studio
│   └── src/
│       ├── app/            # routes and same-origin proxy
│       ├── components/     # agent catalog, builder, chat, shared UI
│       ├── lib/            # Mastra client, models, agents, threads
│       └── server/         # auth seam, proxy validation, payload helpers
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
