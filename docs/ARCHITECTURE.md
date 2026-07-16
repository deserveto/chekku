# Chekku Architecture

## Overview

Chekku contains three npm workspaces: a Next.js client, a Mastra agent server, and the shared `@chekku/storage` package. The system is local-first, uses LibSQL for agent and conversation persistence, offers Garage-backed generic agent object storage plus PM report persistence, and connects to one server-owned OpenAI-compatible model endpoint.

```text
┌───────────────────────────────┐
│ Browser                       │
│ Agents, chat, report pages    │
└───────────────┬───────────────┘
                │ HTTP /api/agent/*
                ▼
┌───────────────────────────────┐
│ Next.js client :3000          │
│ Same-origin proxy + auth seam │
└───────────────┬───────────────┘
                │ Mastra HTTP API
                ▼
┌──────────────────────────────────────────┐
│ Mastra server :4111                      │
│                                          │
│  Code agents      Stored agents          │
│  - main-agent     - @mastra/editor       │
│  - pm-agent       - database versions    │
│  - qa-web-agent                          │
│                                          │
│  Memory + LibSQLStore                    │
│  Calculator + current-time tools         │
│  Garage MCP + PM report tools            │
│  Agent Browser                           │
│  OpenAI-compatible custom gateway        │
└───────────────────┬──────────────────────┘
                    │ /v1/models
                    │ /v1/chat/completions
                    ▼
┌──────────────────────────────────────────┐
│ Rafiqspace LLM, LiteLLM, vLLM, or other │
│ OpenAI-compatible endpoint               │
└──────────────────────────────────────────┘

Mastra server ──► @chekku/storage ──► Garage/S3 `chekku-objects`
```

## Backend composition

`agent/src/mastra/index.ts` creates the single `Mastra` instance and registers:

- `mainAgent`, `pmAgent`, and `qaWebAgent`;
- `storedAgentTools`;
- `LibSQLStore`;
- `MastraEditor` with database storage;
- `OpenAICompatibleGateway`;
- built-in `garageMcpServer` under MCP server ID `garage`;
- structured logging and request middleware;
- `/healthz` and `/models` custom routes.

All other agent, Memory, editor, and storage APIs are provided by Mastra. Chekku does not maintain a parallel custom conversation or agent database.

## Agents

### Main Agent

`main-agent` is the default general-purpose assistant. It uses the common server model and Mastra Memory. It does not claim browser capabilities.

### QA Web Agent

`qa-web-agent` adds Mastra Agent Browser to the common model and Memory stack. Memory is mandatory because browser context processors need a live Memory context during tool loops.

Interactive browser tools require approval unless the request context explicitly enables full browser access. Consequential actions still require user confirmation through the agent instructions.

### PM Agent

`pm-agent` is a protected code-defined agent with Memory. It analyzes engineering weekly reports, derives a 1-10 risk rating and matching status, and owns three code-defined tools: `save_pm_report_to_garage`, `list_pm_reports_from_garage`, and `view_pm_report_from_garage`.

These PM tools are registered only on PM Agent. They compose `@chekku/storage` through a fixed `pm-agent` namespace and are intentionally separate from generic Garage MCP. No model, route, browser request, or local identity can select the PM storage namespace.

### Stored agents

Stored agents are created through the client and persisted by `@mastra/editor`. A stored record contains behavior, model selection, Memory configuration, tools, and delegate-agent references. It does not contain endpoint credentials.

The builder offers one whitelisted MCP capability, `garage`. Selection persists as `mcpClients: { garage: { tools: {} } }`, and hydration resolves that ID against the built-in server. The trusted proxy accepts stored-agent MCP configuration only when absent or exactly that shape, so direct browser requests cannot supply arbitrary MCP URLs, commands, packages, or credentials.

When an older stored model no longer matches the current registry, the client migrates it to the configured gateway and canonical default before chat begins.

## Model gateway

The model contract is provider-neutral:

```text
LLM_BASE_URL
LLM_API_KEY
LLM_DEFAULT_MODEL
LLM_DISPLAY_NAME
LLM_MODELS
```

`getServerModel()` converts the endpoint-native default model into Chekku's custom Mastra gateway ID. The custom gateway:

1. discovers models through `GET {LLM_BASE_URL}/models`;
2. falls back to `LLM_MODELS` and `LLM_DEFAULT_MODEL` when discovery is unavailable;
3. retrieves the server-only API key;
4. creates an OpenAI-compatible chat model;
5. normalizes final prompts before generation and streaming.

The internal model format is:

```text
openai-compatible/gateway/{endpoint-native-model-id}
```

Endpoint-native IDs may contain slashes and are preserved exactly.

## System-message normalization

Some hosted vLLM chat templates reject a system message that appears after user, assistant, or tool messages. Browser and Memory processors may add context late in the prompt pipeline.

`system-message-normalizer.ts` runs at the final model transport boundary. It extracts all system messages, merges their text in original order, places the merged message first, and leaves every non-system message in its original sequence.

This normalization applies to both `doGenerate` and `doStream`.

## Storage

`LibSQLStore` is the only persistence layer for Mastra-managed state. It stores:

- stored-agent definitions and versions;
- Mastra Memory threads and messages;
- other Mastra-managed state.

The default URL is `file:./mastra.db`. The actual file location depends on the working directory used to launch the agent workspace.

`@chekku/storage` is a separate generic object-storage boundary, not a replacement for LibSQL. It defines create, replace, get, existence, delete, and bounded-list operations and implements them through Garage's S3-compatible API. Application configuration uses only:

```text
GARAGE_ENDPOINT
GARAGE_REGION
GARAGE_BUCKET
GARAGE_ACCESS_KEY_ID
GARAGE_SECRET_ACCESS_KEY
```

The local launcher uses generic bucket `chekku-objects`. Adapter errors use fixed safe messages for collision, not-found, configuration, and availability failures; credentials, endpoints, provider bodies, headers, and request IDs are not exposed.

## Garage MCP

`garageMcpServer` has a fixed registry containing exactly:

- `create_text_object`;
- `get_text_object`;
- `list_text_objects`;
- `replace_text_object`;
- `delete_object`.

Tools expose generic UTF-8 text-object behavior only. They derive identity from trusted Mastra execution context at `context.agent.agentId`; agent identity is never accepted in model-generated input. Missing context fails before storage access.

For agent ID `agentId` and validated relative key `key`, the physical object key is:

```text
agents/<base64url(agentId)>/<key>
```

Tools accept and return relative keys only. Relative keys must be non-empty, use forward slashes, contain no absolute path, backslash, traversal segment, control character, or empty segment, and fit within 512 UTF-8 bytes. List prefixes follow the same path rules but may be empty or end in one slash. Text payloads fit within 262,144 UTF-8 bytes. Lists fetch at most 101 objects and expose at most 100 keys with `truncated` set when more exist.

`create_text_object` fails if the object exists. `replace_text_object` and `delete_object` require approval and fail for missing targets. Garage v2.3.0 does not implement destination conditional PUT/DELETE headers, so the adapter serializes same-key mutations and checks existence immediately within one adapter instance; external Garage writers remain outside that guarantee. Get and list are read-only. MCP annotations describe read-only, destructive, idempotent, and closed-world behavior.

## PM report storage

`storage/src/pm-reports.ts` adds domain behavior above the generic storage contract without changing Garage MCP. Both PM Agent tools and the server-only client report service call `createPmReportStorage()`, which always binds storage to `pm-agent`.

Each report stores three logical objects:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

Metadata is written last so partial saves do not become list entries. Metadata and public outputs retain only relative keys; physical `agents/<base64url(pm-agent)>/...` keys remain inside the namespaced adapter. There is no migration or fallback for old global development objects.

Generated IDs use canonical public form `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>` and public detail access enforces `^pmr_[0-9]{14}_[0-9a-f]{8}$`. Repository-level helpers accept broader IDs for internal validation and tests, but those are not public report identifiers.

The list tool returns newest-first structured reports and presentation-only `reportUrl` and `reportsMarkdown` fields. Neither field enters persisted metadata, save output, view output, or repository types. `reportsMarkdown` is deterministic GFM with columns `Report`, `Created`, `Risk`, and `Status`; PM Agent returns it unchanged. Valid timestamps render to minute precision in UTC, while invalid stored text is preserved with Markdown-safe escaping.

## Conversation ownership

Every thread is owned by an agent and resource:

```text
{agentId}-{resourceId}-{uuid}
```

The client validates this prefix before listing, reading, renaming, or deleting a thread. Changing agents creates or opens a thread owned by that agent; a conversation cannot silently switch its owner.

## Client boundaries

The browser uses `@mastra/client-js` with the Next.js origin and `/api/agent` prefix. The catch-all proxy:

- resolves the server-controlled local identity;
- validates the requested path;
- rejects stored-agent create/update payloads whose MCP configuration is not absent or exactly `garage: { tools: {} }`;
- forwards requests to `AGENT_URL`;
- attaches an optional service credential;
- supports GET, POST, PUT, PATCH, DELETE, and HEAD;
- streams the upstream response back to the browser.

The current identity implementation is intentionally replaceable. Future OIDC must preserve the same resource and thread-ownership checks.

Garage access remains server-side through hydrated agent tools. Browser components neither import `@chekku/storage` nor make direct S3/Garage requests.

`client/src/server/pm-reports.ts` is a separate server-only boundary for report pages and APIs. It requires the same server identity seam before storage access, validates public report IDs before reads, fixes the namespace to `pm-agent`, and maps provider failures to safe 400, 403, 404, or 503 responses. OIDC may replace `CHEKKU_LOCAL_USER_ID` later without changing namespace or report-access semantics.

Chat report links use URL-encoded relative `/reports/<reportId>` URLs and render in a new tab with `rel="noreferrer"`. GFM tables are wrapped in labeled, keyboard-focusable horizontal-scroll regions with visible focus outlines. `/reports` uses the same accessibility pattern for its server-rendered list table, preventing narrow layouts from compressing report columns.

## Public routes

### Next.js

- `/` redirects to `/agents`.
- `/agents` lists code-defined and stored agents.
- `/agents/new` creates a stored agent.
- `/agents/[id]/edit` edits a stored agent.
- `/chat` opens the canonical query-based chat route.
- `/chat/[threadId]` redirects legacy thread URLs to the canonical route.
- `/reports` lists PM reports newest first.
- `/reports/[reportId]` renders analysis, metadata, and original input.
- `/api/agent/[...path]` proxies Mastra HTTP requests.
- `GET /api/storage/pm-reports` returns report metadata after identity validation.
- `GET /api/storage/pm-reports/[reportId]` returns one report after identity and ID validation.

### Mastra custom routes

- `/healthz` reports service status.
- `/models` reports model configuration, canonical default, and available models.

## Extension points

Add future functionality through these boundaries:

- code-defined agents in `agent/src/agents/`;
- registered stored-agent tools in `agent/src/mastra/tools/`;
- generic object-storage implementations in `storage/`;
- provider-neutral gateway behavior in `agent/src/mastra/gateways/`;
- server request context and future authentication seam;
- routed client components and Mastra client helpers.

Do not add a second persistence, provider, agent-registry, or conversation architecture alongside the active one.
