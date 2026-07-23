# Chekku Architecture

## Overview

Chekku contains three npm workspaces: a Next.js client, a Mastra agent server, and the shared `@chekku/storage` package. The system is local-first, uses LibSQL for agent and conversation persistence, offers Garage-backed generic agent object storage plus PM report persistence, connects to one server-owned OpenAI-compatible model endpoint, provides bounded web search through a server-owned SearXNG endpoint, and reads chosen public pages through hosted Jina Reader.

```text
┌────────────────────────────────────────────┐
│ Browser                                    │
│ Agent catalog, builder, chat, PM reports   │
└───────────────────┬────────────────────────┘
                    │ HTTP /api/agent/*
                    ▼
┌────────────────────────────────────────────┐
│ Next.js client/server :3000                │
│ Same-origin proxy + auth seam              │
│ /reports/* + /api/storage/pm-reports/* ────────────┐
└───────────────────┬────────────────────────┘        │
                    │ Mastra HTTP API                 │
                    ▼                                 │
┌────────────────────────────────────────────┐        │
│ Mastra server :4111                        │        │
│                                            │        │
│ Code agents          Stored agents         │        │
│ - main-agent         - @mastra/editor      │        │
│ - pm-agent           - database versions   │        │
│ - qa-web-agent                             │        │
│ - qa-android-agent                         │        │
│ - social-media-agent                       │        │
│                                            │        │
│ Memory + LibSQLStore                       │        │
│ Calculator + current-time + email tools    │        │
│ Garage + SearXNG + Web Reader MCP          │        │
│ Chat SDK + Telegram adapter                │        │
│ Agent Browser                              │        │
│ OpenAI-compatible custom gateway           │        │
└──────────────┬────────────────────┬────────┘        │
               │                    │                 │
               │                    │ PM-Agent-only   │
               │                    │ report tools    │
               │                    └─────────────────┤
               │ /v1/models                           │
               │ /v1/chat/completions                 │
               ▼                                      │
┌────────────────────────────────────────────┐         │
│ Rafiqspace LLM, LiteLLM, vLLM, or other   │         │
│ OpenAI-compatible endpoint                 │         │
└────────────────────────────────────────────┘         │
                                                       ▼
Next.js report service / Garage MCP ──► @chekku/storage
                                             │
                                             ▼
                                   Garage/S3 `chekku-objects`

PM Agent / selected stored agent
  -> search_web -> fixed SearXNG -> candidate URLs/snippets
  -> read_web_page -> fixed Web Reader client -> hosted Jina Reader
  -> bounded untrusted Markdown
```

## Backend composition

`agent/src/mastra/index.ts` creates the single `Mastra` instance and registers:

- `mainAgent`, `pmAgent`, `qaWebAgent`, `qaAndroidAgent`, and `socialMediaAgent`;
- `storedAgentTools` (`calculatorTool`, `getCurrentTimeTool`, and `sendEmailTool`) for stored-agent hydration;
- `garageMcpServer` for generic agent-isolated object storage;
- `searxngMcpServer` for fixed read-only web search by selected stored agents;
- `webReaderMcpServer` for fixed read-only hosted page reading by selected stored agents;
- `LibSQLStore`;
- `MastraEditor` with database storage;
- `OpenAICompatibleGateway`;
- structured logging and request middleware;
- `/healthz` and `/models` custom routes.

Mastra provides the native agent, Memory, and editor APIs. Next.js separately provides `/reports/*` pages and `/api/storage/pm-reports/*` APIs through `client/src/server/pm-reports.ts`; those PM report storage interfaces are not Mastra APIs. Chekku does not maintain a parallel custom conversation or agent database.

`storedAgentTools` is the instance-level registry that makes calculator, current-time, and email tools available during stored-agent hydration. PM report tools and the reusable `search_web` and `read_web_page` tools are attached directly to `pmAgent`; PM report tools are not members of `storedAgentTools`, `garageMcpServer`, `searxngMcpServer`, or `webReaderMcpServer`.

`socialMediaAgent` also wires a Telegram channel adapter. Once Mastra initializes the agent's `AgentChannels`, `index.ts` registers the agent's slash-command handlers (`/help`, `/roles`, `/role`, `/switch`) on the Chat SDK so Telegram-intercepted bot commands reach the role logic.

## Agents

### Main Agent

`main-agent` is the default general-purpose assistant. It uses the common server model and Mastra Memory. It does not claim browser capabilities.

### QA Web Agent

`qa-web-agent` adds Mastra Agent Browser to the common model and Memory stack. Memory is mandatory because browser context processors need a live Memory context during tool loops.

No tool requires approval — browser actions and outbound email run directly.

### QA Android Agent

`qa-android-agent` is the mobile counterpart to `qa-web-agent`. It shares the common server model, Mastra Memory, and gateway compatibility processor. A trusted, env-gated `MCPClient` connects to the local `maestro mcp` server over stdio and exposes only an explicit allowlist of the built-in server's tools (`list_devices`, `inspect_screen`, `take_screenshot`, `cheat_sheet`, `run`). `run_flow_files`, the cloud tools (`run_on_cloud`, `list_cloud_devices`, `get_cloud_run_status`), and `open_maestro_viewer` are never exposed. On Windows the `.bat`/`.cmd` Maestro command is routed through `cmd.exe /c` (Node blocks direct `.bat` spawn).

No tool requires approval — `maestro_run` (which executes flows, including inline/generated YAML) and the curated `run_maestro_flow` runner execute directly. There are no granular single-action tools — every device interaction (tap, input, back, launch) is expressed as inline YAML through `maestro_run`.

The curated `run_maestro_flow` tool resolves logical `{ suite, flow }` names to checked-in YAML under `MAESTRO_WORKSPACE`, validates real-path containment after symlink resolution, confirms a regular file, and runs via `execFile` (never a shell string) with `--format junit --output` and `--test-output-dir` writing into `artifacts/maestro/<runId>/`. It never reports Passed unless Maestro exits 0. A read-only `current_app` tool queries adb for the foreground app's package so the agent can self-serve the `appId`.

Maestro is disabled by default; the agent and server boot normally without it.

### Social Media Agent

`social-media-agent` is a role-switchable content assistant reachable over a Mastra channel (Telegram today, other platforms later). It shares the common server model and Memory stack with the other code agents and adds a Telegram adapter through the Chat SDK.

Users drive it from the chat platform with slash commands:

- `/help` — show available commands;
- `/roles` — list roles; `/role` — show the active role;
- `/switch <role>` — switch between `general`, `x-writer`, `instagram-writer`, `linkedin-writer`, and `tiktok-writer`.

The active role is held in-memory keyed by `${platform}:${userId}`. The agent reads the role from the channel context on `requestContext` and rebuilds its instructions on each turn. Phase scope is drafting and planning only; destination-platform publishing is a later phase.

### PM Agent

`pm-agent` is a protected code-defined agent with Memory. It analyzes engineering weekly reports, derives a 1-10 risk rating and matching status, owns three code-defined report tools (`save_pm_report_to_garage`, `list_pm_reports_from_garage`, and `view_pm_report_from_garage`), and receives the reusable `search_web` and `read_web_page` tools.

These PM tools are registered only on PM Agent. They compose `@chekku/storage` through a fixed `pm-agent` namespace and are intentionally separate from generic Garage MCP. No model, route, browser request, or local identity can select the PM storage namespace.

`search_web` discovers candidate URLs and returns bounded metadata and snippets. `read_web_page` can then read one chosen public page into bounded untrusted Markdown. PM Agent instructions do not require research, orchestration, or a five-product competitive analysis; competitive analysis remains future work requiring independent review.

### Stored agents

Stored agents are created through the client and persisted by `@mastra/editor`. A stored record contains behavior, model selection, Memory configuration, tools, and delegate-agent references. It does not contain endpoint credentials.

Selecting Garage persists the fixed editor shape `mcpClients: { garage: { tools: {} } }`. The Next.js proxy accepts only that built-in shape and rejects arbitrary MCP URLs, commands, packages, environment values, and credentials before forwarding stored-agent mutations.

Selecting SearXNG persists the separate fixed shape `mcpClients: { searxng: { tools: {} } }`. Selecting Web Reader persists `mcpClients: { 'web-reader': { tools: {} } }`. Stored records never contain SearXNG configuration or the Web Reader key. The proxy permits any non-empty subset of Garage, SearXNG, and Web Reader while rejecting custom endpoints, headers, credentials, tool overrides, and other connection configuration.

When an older stored model no longer matches the current registry, the client migrates it to the configured gateway and canonical default before chat begins.

## Workflows

Workflows are registered on the `Mastra` instance through its `workflows` field and live in `agent/src/mastra/workflows/`. Declaring a `schedule` on a workflow auto-promotes it to the evented execution engine; the built-in scheduler reads the `schedule` field on boot and fires the run on the configured cron — no separate registration call.

The scheduler runs on the long-lived `mastra` host process (`mastra dev` / `mastra start`), so scheduled fires work without extra setup. Evented runs require a storage adapter that supports concurrent updates; Chekku uses `LibSQLStore`, which satisfies this.

`weekly-social-drafts` fires every Monday at 09:00 Asia/Jakarta and drafts 2–3 Instagram greeting-card posts per run. Each fire resolves 2 base topics from SearXNG trending research (`trending-research.ts` → the existing `search_web` tool, snippet-only — no page crawling), fills any remaining base slot from the deterministic evergreen-pillar rotation, then appends one awareness-day bonus from `selectBonusAwarenessDayForWeek` when the week contains a holiday. Awareness-day candidates come from two merged sources: the Public Holiday Indonesia API (`agent/src/mastra/calendar/public-holidays.ts`, fetches Idul Fitri, Idul Adha, 1 Muharram, Isra Mi'raj, Maulid Nabi, Nyepi, Paskah, Waisak, Natal, etc. with their Gregorian dates and Hijri year labels) and the fixed-date `SPECIAL_DAYS` calendar (covers observance days that are not national holidays, like Hari Kartini or Hari Guru Nasional). When both sources have an entry on the same date, the API wins because it is authoritative and usually carries the Hijri year. The API response is cached per year on disk so a single fire does not re-fetch 30+ years of data and an offline API does not block the workflow; if the API is unconfigured or unreachable, the selector falls back to fixed-date `SPECIAL_DAYS` only. Trending results whose title or snippet overlaps the chosen awareness day are skipped so the bonus and a base slot do not duplicate the same theme. When SearXNG is not configured or every research query fails, the workflow degrades to 2 evergreen pillars with no awareness bonus and records a `researchNote`. Each draft is generated through `socialMediaAgent.generate(..., { instructions })` with the `instagram-writer` role pinned (the workflow runs outside any chat channel, so the role cannot come from channel context); the role carries the brand identity ("R — Your Gentle AI Companion", tagline "AI Human-Centered Intelligence", sign-off "Hormat kami, Keluarga Besar PT Rafiq Space Intelligence") and `buildDraftPrompt` shapes the output into a structured greeting-card copy (header → title → canonical date line — for Islamic holidays, the Hijri year from the API; for civic days, the Indonesian long-form Gregorian date; for trending/evergreen, omitted → opening → optional religious/cultural verse with attribution → "Poin-poin" brand-value bullets with `**[Value]:**` elaboration format → tagline → sign-off). Title templates differ by topic kind: `Selamat {day}` for special days, `Tren Minggu Ini: {headline}` for trending, and a short themed headline for evergreen pillars. Each draft is persisted through the existing Garage MCP `create_text_object` tool with `agentId` pinned to `social-media-agent`, and emailed as a review link to `SOCIAL_DRAFT_REVIEW_EMAIL`. Email delivery failure is recorded without failing the run, so drafts remain saved. Research never modifies voice, storage, the canonical post id / key layout, or notification.

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

## SearXNG search

`searxngMcpServer` has fixed ID `searxng` and an immutable registry containing exactly `search_web`. Stored agents use that MCP server; PM Agent binds the same reusable tool directly. Garage MCP remains an independent registry with exactly five generic object tools.

Application configuration has two server-owned values:

```text
SEARXNG_BASE_URL
SEARXNG_API_KEY
```

`SEARXNG_BASE_URL` may include a deployment path, but not credentials, query parameters, or a fragment. `SEARXNG_API_KEY` is optional and becomes an `Authorization: Bearer` header for an authenticated external reverse proxy. Neither value reaches stored-agent records, browser code, model-generated input, or tool output.

The client sends only `GET {SEARXNG_BASE_URL}/config` and `POST {SEARXNG_BASE_URL}/search`. `/config` validates optional language, category, and engine targeting and is cached for five minutes. Search uses form-encoded fixed fields, requires JSON responses, rejects redirects, and shares one 12-second deadline across capability validation and search.

Input is bounded to a trimmed non-empty query of at most 1,024 UTF-8 bytes, 1-20 results, pages 1-5, at most 5 unique categories and 10 unique engines, safe-search level 0-2, and time range `day`, `month`, or `year`. Upstream bodies stop at 2 MiB. Normalized output stops at 131,072 UTF-8 bytes and contains at most 20 HTTP(S) results, 5 answers, 10 corrections, and 10 suggestions. Result URLs are limited to 2,048 bytes, titles to 512, snippets to 4,096, categories to 128, and each result to 8 unique engine names of 128 bytes each. Answers are limited to 2,048 bytes each; corrections and suggestions are limited to 512 each. `truncated` reports omitted or shortened data.

Errors use fixed configuration, availability, timeout, format, size, response, targeting, and input messages. They do not repeat endpoint URLs, bearer tokens, queries, upstream bodies, diagnostics, headers, or request IDs. MCP annotations mark search read-only, non-destructive, idempotent, and open-world; it does not require approval.

## Hosted Web Reader

`webReaderMcpServer` is a fixed local in-process wrapper with ID `web-reader` and an immutable registry containing exactly `read_web_page`. It is not a dynamically configurable remote MCP server. PM Agent binds the same reusable tool directly; stored agents may select Web Reader independently or together with Garage and SearXNG. Garage remains fixed at five generic object tools, and SearXNG remains fixed at `search_web`.

The provider endpoint is fixed in code to external hosted API `https://r.jina.ai/`. Application configuration adds only server-owned, provider-neutral `WEB_READER_API_KEY`. Missing or malformed configuration never blocks server startup; tool execution fails with fixed configuration error. Chekku does not use anonymous fallback or run local Reader service.

`read_web_page` accepts exactly one public HTTP(S) URL of at most 2,048 UTF-8 bytes. Chekku rejects URL credentials, control characters, local hostnames, non-default ports, and literal non-public IP addresses before provider access. It then sends exactly one fixed POST with normalized target URL, fixed headers, rejected API redirects, and one 30-second deadline. Response MIME must be JSON, streamed body stops above 2 MiB, title is limited to 512 UTF-8 bytes, and serialized normalized output is limited to 71,680 UTF-8 bytes.

Data flow is search then read:

```text
PM Agent / selected stored agent
  -> search_web -> fixed SearXNG -> candidate URLs/snippets
  -> read_web_page -> fixed Web Reader client -> hosted Jina Reader
  -> bounded untrusted Markdown
```

Public target URL and extracted page content pass through Jina. Jina is an external hosted API, and Chekku does not control Jina's retention, remote DNS resolution, target redirects, provider availability, or provider-side network isolation. Local URL validation does not provide end-to-end SSRF or redirect control over Jina's remote fetch.

Normalized output contains only requested and provider-reported source URLs, title, Markdown, `contentIsUntrusted: true`, and truncation state. Public errors are fixed and bounded; they do not expose keys, target URLs, endpoint details, headers, provider bodies, diagnostics, stacks, timings, usage, or request IDs. Returned Markdown may contain prompt injection. Treat it only as untrusted evidence, never instructions; bounding and labeling content do not make it trusted.

Each invocation reads one chosen public page. It does not discover URLs, crawl, recursively follow links, authenticate to target pages, handle PDFs or uploads, return screenshots, persist content, or perform competitive analysis. Competitive-analysis orchestration remains deferred to separately reviewed work.

## System-message normalization

Some hosted vLLM chat templates reject a system message that appears after user, assistant, or tool messages. Browser and Memory processors may add context late in the prompt pipeline.

`system-message-normalizer.ts` runs at the final model transport boundary. It extracts all system messages, merges their text in original order, places the merged message first, and leaves every non-system message in its original sequence.

This normalization applies to both `doGenerate` and `doStream`.

## Storage

`LibSQLStore` is the only persistence layer. It stores:

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

`create_text_object` fails if the object exists. `replace_text_object` and `delete_object` run directly (no approval gate) and fail for missing targets. Garage v2.3.0 does not implement destination conditional PUT/DELETE headers, so the adapter serializes same-key mutations and checks existence immediately within one adapter instance; external Garage writers remain outside that guarantee. Get and list are read-only. MCP annotations describe read-only, destructive, idempotent, and closed-world behavior.

## PM report storage

`storage/src/pm-reports.ts` adds domain behavior above the generic storage contract without changing Garage MCP. Both PM Agent tools and the server-only client report service call `createPmReportStorage()`, which always binds storage to `pm-agent`.

Each report stores three logical objects:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

Metadata is written last so partial saves do not become list entries. Metadata and public outputs retain only relative keys; physical `agents/<base64url(pm-agent)>/...` keys remain inside the namespaced adapter. There is no migration or fallback for old global development objects.

Generated IDs and every repository, tool, and public detail boundary use canonical form `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pmr_[0-9]{14}_[0-9a-f]{8}$`. Noncanonical metadata is skipped during listing; there is no compatibility fallback.

The list tool returns newest-first structured reports and presentation-only `reportUrl` and `reportsMarkdown` fields. Neither field enters persisted metadata, save output, view output, or repository types. `reportsMarkdown` is deterministic GFM with columns `Report`, `Created`, `Risk`, and `Status`; PM Agent returns it unchanged. Valid timestamps render to minute precision in UTC, while invalid stored text is preserved with Markdown-safe escaping.

## Social post storage

`storage/src/social-posts.ts` adds domain behavior above the generic storage contract without changing Garage MCP. It exposes only pure canonical helpers (`buildSocialPostMetadata`, `createPostId`, `keysFor`, parse helpers) and read helpers (`listSocialPosts`, `getSocialPost`, `createSocialPostStorage`) — no write helper that takes an `ObjectStorage`. The scheduled `weekly-social-drafts` workflow writes through the existing Garage MCP `create_text_object` tool; the client/server read path calls `listSocialPosts` / `getSocialPost` via `createSocialPostStorage()` over the same root storage.

The workflow invokes the MCP tool with a trusted context that pins `agentId` to `social-media-agent`, so the tool's namespace derivation lands writes in the same physical namespace the read path reads from. The workflow never calls `@chekku/storage` write APIs directly and never accepts namespace from tool input.

Each post stores three logical objects:

```text
social-posts/<postId>/post.md
social-posts/<postId>/brief.md
social-posts/<postId>/metadata.json
```

`post.md` is the drafted caption, `brief.md` is the deterministic topic brief that generated it, and `metadata.json` is written last so partial saves never become list entries. Metadata retains only relative keys; physical `agents/<base64url(social-media-agent)>/...` keys remain inside the namespaced adapter.

Generated IDs and every repository, workflow, and public detail boundary use canonical form `smp_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^smp_[0-9]{14}_[0-9a-f]{8}$`. Noncanonical metadata is skipped during listing; there is no compatibility fallback. Social-post semantics stay outside Garage MCP; no social-post tool is registered on the generic five-tool MCP server.

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
- forwards requests to `AGENT_URL`;
- attaches an optional service credential;
- supports GET, POST, PUT, PATCH, DELETE, and HEAD;
- streams the upstream response back to the browser.

The current identity implementation is intentionally replaceable. Future OIDC must preserve the same resource and thread-ownership checks.

Garage access remains server-side through two explicit paths. Chat tool calls pass through `/api/agent/*`, Mastra, and hydrated agent tools. Report pages and `/api/storage/pm-reports/*` execute in the Next.js server and call `client/src/server/pm-reports.ts` directly. Browser components neither import `@chekku/storage` nor make direct S3/Garage requests.

SearXNG and Web Reader also remain server-side. Builder state carries only fixed capability selection; browser requests cannot set endpoints, keys, headers, commands, packages, environment, provider controls, or tool registries. Search and page-reading requests run from the Mastra process through fixed clients.

`client/src/server/pm-reports.ts` is a separate server-only boundary for report pages and APIs. It requires the same server identity seam before storage access, validates public report IDs before reads, fixes the namespace to `pm-agent`, and maps provider failures to safe 400, 403, 404, or 503 responses. OIDC may replace `CHEKKU_LOCAL_USER_ID` later without changing namespace or report-access semantics.

`client/src/server/social-posts.ts` mirrors that boundary for the social-post review UI. It fixes the namespace to `social-media-agent`, validates `smp_...` IDs before reads, requires the same identity seam, and maps provider failures to the same safe responses. Social-post pages and `/api/storage/social-posts/*` execute in the Next.js server and never import `@chekku/storage` from browser code.

Chat report links use URL-encoded relative `/reports/<reportId>` URLs and render in a new tab with `rel="noreferrer"`. GFM tables are wrapped in labeled, keyboard-focusable horizontal-scroll regions with visible focus outlines. `/reports` and `/social-posts` use the same accessibility pattern for their server-rendered list tables, preventing narrow layouts from compressing columns.

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
- `/social-posts` lists scheduled Instagram drafts newest first.
- `/social-posts/[postId]` renders caption, metadata, and brief.
- `/api/agent/[...path]` proxies Mastra HTTP requests.
- `GET /api/storage/pm-reports` returns report metadata after identity validation.
- `GET /api/storage/pm-reports/[reportId]` returns one report after identity and ID validation.
- `GET /api/storage/social-posts` returns post metadata after identity validation.
- `GET /api/storage/social-posts/[postId]` returns one post after identity and ID validation.

### Mastra custom routes

- `/healthz` reports service status.
- `/models` reports model configuration, canonical default, and available models.

## Extension points

Add future functionality through these boundaries:

- code-defined agents in `agent/src/agents/`;
- registered stored-agent tools in `agent/src/mastra/tools/`;
- provider-neutral gateway behavior in `agent/src/mastra/gateways/`;
- bounded search transport in `agent/src/mastra/searxng/` and one-page hosted reading in `agent/src/mastra/web-reader/`, without adding crawling or authenticated fetching;
- server request context and future authentication seam;
- routed client components and Mastra client helpers.

Do not add a second persistence, provider, agent-registry, or conversation architecture alongside the active one.
