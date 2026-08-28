# Chekku Architecture

## Overview

Chekku contains three npm workspaces: a Next.js client, a Mastra agent server, and the shared `@chekku/storage` package. The system is local-first, uses Postgres for agent and conversation persistence, offers Garage-backed generic agent object storage plus weekly and competitive PM report persistence, connects to one server-owned OpenAI-compatible model endpoint, provides bounded web search through a server-owned SearXNG endpoint, and reads chosen public pages through a self-hosted Jina Reader OSS container.

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
│ /reports/* + PM storage APIs ──────────────────────┐
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
│ - social-media-content-writer              │        │
│ - social-media-supervisor-agent            │        │
│ - social-media-strategist-agent            │        │
│ - visual-content-agent                     │        │
│                                            │        │
│ Memory + PostgresStore                      │        │
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
  -> read_web_page -> fixed Web Reader client -> self-hosted Reader container
  -> bounded untrusted Markdown

PM competitive analysis
  -> competitive-analysis skill
  -> up to 5 search_web calls
  -> up to 8 read_web_page calls
  -> evidence-only synthesis
  -> save_competitive_analysis_to_garage
  -> competitive-analyses/<pca-id>/{request.md,analysis.md,metadata.json}
  -> /reports/competitive/<pca-id>
```

## Deployment topology

Chekku has two deployment modes, kept apart by Compose profiles so neither mode touches the other's runtime:

- **Development** — `scripts/dev.sh` starts only the stateful third-party services in containers (Garage, SearXNG, Reader, Postgres) and runs the agent and client as host processes (`npm run dev:agent`, `npm run dev:client`). The launcher never activates the `prod` profile, so the `agent` and `client` Compose services stay absent.
- **Production** — `scripts/prod.sh` activates the `prod` profile and brings the whole stack up as containers: Garage, SearXNG, Reader, Postgres, `agent`, and `client`. The agent and client never run on the host.

The application services in `compose.yaml` are gated behind `profiles: [prod]` and use `${VAR:-}` interpolation defaults, so the development launcher's `docker compose config --quiet` validation still passes without production secrets present. `scripts/prod.sh` is the only path that activates the profile and the only place that fails closed on missing required values.

Production traffic flow:

```text
Browser
  │
  ▼
Reverse proxy (Caddy/nginx, host) ── TLS, public exposure
  │
  ▼
client :3000  (container, 127.0.0.1:3000 published)
  ├── /api/agent/* same-origin proxy ──► agent:4111 (container, no published port)
  │                                        ├── postgres:5432 (container)
  │                                        ├── garage:3900   (container)
  │                                        ├── searxng:8080  (container)
  │                                        └── OpenAI-compatible endpoint (external)
  └── /reports/* + /api/storage/* ──► @chekku/storage ──► garage:3900
```

In-container wiring invariants:

- The agent binds `HOST=0.0.0.0` so it is reachable from the `client` container over the Compose default network; its port `4111` is intentionally not published to the host.
- The client's same-origin proxy targets `AGENT_URL=http://agent:4111` (the Compose service name), not `localhost`.
- `DATABASE_URL` is constructed with the `postgres` service hostname, not `127.0.0.1`.
- SearXNG is reached at `http://searxng:8080` (the container's internal port), not the loopback `8888` used in development.
- Reader is reached at `http://reader:8081` (the container's HTTP/1.1 port), matching the dev loopback port `8081`.

### Image build model

Both application images are multi-stage and build from the repository root (not the workspace directory) because `npm ci` must resolve the `@chekku/storage` workspace symlink and each bundler must be able to follow `storage/`:

- `agent/Dockerfile` runs `npm run build --workspace agent`, then copies the emitted `agent/.mastra/output/` bundle plus production `node_modules` into a `node:22-bookworm-slim` runtime that also installs system Chromium for the QA Web Agent (`@mastra/agent-browser` depends on `playwright-core`, which does not download a browser) and exports `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`, which `agent/src/mastra/browsers.ts` forwards to `AgentBrowser` as `executablePath`. Mastra currently inlines `@chekku/storage` into the bundle; the `storage/` workspace is copied into the image as well so the runtime layout matches the build layout even if a future Mastra version externalizes it.
- `client/Dockerfile` runs `npm run build --workspace client` and copies the Next.js standalone output. `client/next.config.ts` sets `output: 'standalone'`, `outputFileTracingRoot` to the repo root, and `transpilePackages: ['@chekku/storage']` so standalone file tracing follows the raw-TypeScript storage workspace and its `@aws-sdk/client-s3` dependency into `.next/standalone/`.

Secrets are injected exclusively through Compose `environment:` interpolation; no secret is baked into either image. `scripts/prod.sh` parses the four dotenv files with node+dotenv (never bash `source`, which cannot parse values containing spaces or special characters). Service-only secrets (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`, `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`) may be present in Compose's interpolation context, but they never enter the agent or client containers because their `environment:` blocks do not declare them; `SEARXNG_SECRET` and `SEARXNG_CONFIG_HASH` legitimately reach the `searxng` container, which declares them.

## Backend composition

`agent/src/mastra/index.ts` creates the single `Mastra` instance and registers:

- `mainAgent`, `pmAgent`, `qaWebAgent`, `qaAndroidAgent`, `socialMediaContentWriter`, `socialMediaSupervisorAgent`, `socialMediaStrategistAgent`, and `visualContentAgent`;
- `storedAgentTools` (`calculatorTool`, `getCurrentTimeTool`, and `sendEmailTool`) for stored-agent hydration;
- `garageMcpServer` for generic agent-isolated object storage;
- `searxngMcpServer` for fixed read-only web search by selected stored agents;
- `webReaderMcpServer` for fixed read-only self-hosted page reading by selected stored agents;
- `PostgresStore` (`@mastra/pg`);
- `MastraEditor` with database storage;
- `OpenAICompatibleGateway`;
- structured logging and request middleware;
- `/healthz` and `/models` custom routes;
- the server-owned agent-run routes (`/runs`, `/runs/active`, `/runs/list`, `/runs/:runId`, `/runs/:runId/events`, `/runs/:runId/cancel`).

Mastra provides native agent, Memory, skill, and editor APIs. Next.js separately provides `/reports/*`, `/api/storage/pm-reports/*`, and `/api/storage/competitive-analyses/*` through focused server-only services; those PM storage interfaces are not Mastra APIs. Chekku does not maintain a parallel custom conversation or agent database.

The chat composer (`client/src/components/chat/chat-studio.tsx`) exposes the active agent's user-invocable skills through a client-side slash-command picker. Typing a leading `/` opens a keyboard-navigable listbox populated from the active agent's serialized record — `listAgentSkills` in `client/src/lib/agent-skills.ts` fetches the agent through the same-origin `/api/agent/*` proxy and reads the `.skills` array, keeping only entries whose `user-invocable` flag is not `false`. Selecting a skill inserts `/<skill-name> ` into the input and dispatches through the existing `sendMessage` → `agent.stream()` path. No backend skill-routing change is involved. Agents with no user-invocable skills show no rows and the picker stays closed.

`storedAgentTools` is the instance-level registry that makes calculator, current-time, and email tools available during stored-agent hydration. Weekly and competitive PM tools plus reusable `search_web` and `read_web_page` attach directly to `pmAgent`; PM storage tools are not members of `storedAgentTools`, `garageMcpServer`, `searxngMcpServer`, or `webReaderMcpServer`.

`socialMediaContentWriter` also wires a Telegram channel adapter. Once Mastra initializes the agent's `AgentChannels`, `index.ts` registers the agent's slash-command handlers (`/help`, `/roles`, `/role`, `/switch`) on the Chat SDK so Telegram-intercepted bot commands reach the role logic. `socialMediaSupervisorAgent` binds the reusable `search_web` and `read_web_page` research tools and attaches the Content Writer as a sub-agent via the `agents` field.

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

### Social Media Content Writer

`social-media-content-writer` is a role-switchable content writer and the drafting sub-agent under the Social Media Supervisor. It is reachable over a Mastra channel (Telegram today, other platforms later). It shares the common server model and Memory stack with the other code agents and adds a Telegram adapter through the Chat SDK. The Telegram channel and slash commands stay on this agent for now; the supervisor delegates to it via Mastra's `agents` sub-agent field.

Users drive it from the chat platform with slash commands:

- `/help` — show available commands;
- `/roles` — list roles; `/role` — show the active role;
- `/switch <role>` — switch between `general`, `x-writer`, `instagram-writer`, `linkedin-writer`, and `tiktok-writer`.

The active role is held in-memory keyed by `${platform}:${userId}`. The agent reads the role from the channel context on `requestContext` and rebuilds its instructions on each turn. Phase scope is drafting and planning only; destination-platform publishing is a later phase.

### Social Media Supervisor

`social-media-supervisor-agent` is the routing agent for the social-media surface. It binds exactly two lightweight research tools — the reusable `search_web` and `read_web_page` singletons, used only for quick trending checks and opening user-provided URLs — and delegates drafting/repurposing/planning requests to its sub-agents via Mastra's `agents` field. The supervisor binds Memory and the same context-safety processors as the other code agents so its own turns stay bounded. Active call paths opt into routing by invoking the supervisor; Telegram stays on the Content Writer for this phase. It attaches three sub-agents today: the Content Writer (platform-post drafting/repurposing/planning), the Strategist (Content Strategy Brief and Content Plan research/interviews), and the Visual Content Agent (on-demand image generation for an APPROVED post). These three sub-agents are hidden from the client UI catalog and chat switcher (`HIDDEN_AGENT_IDS` filtered inside `listAllAgents()`); they stay registered server-side and remain delegation targets, so users reach the social-media surface through the supervisor and the scheduled workflow.

### Social Media Strategist

`social-media-strategist-agent` is a code-defined planning and research agent and the second sub-agent under the Social Media Supervisor. It shares the common server model, Mastra Memory, and the standard context-limiter plus char-budget-guard stack used by `main-agent` and `pm-agent`. It binds the reusable `search_web` and `read_web_page` tools directly (the same tools PM Agent binds), and nothing else.

Its conversational workflow is: interview the user to identify the brand, project, product, or person the strategy is for; perform optional web research when it would strengthen a decision; draft a Content Strategy Brief using a generic section template; ask explicitly for review; revise the existing brief on feedback; treat the brief as the source of truth only after explicit user approval; then offer a Content Plan whose shape derives from the approved brief. The agent is a strategist — it does not produce final platform-specific copy.

The Strategist is independent of the Content Writer. It does not wire a Telegram channel, does not register slash commands, and does not participate in the scheduled `weekly-social-drafts` workflow. The supervisor routes strategy/brief/content-plan requests to it via Mastra's `agents` field.

The Strategist keeps approved strategies inside its Mastra Memory thread only. Durable strategy persistence (a `storage/src/strategy-briefs.ts` helper plus a `save_strategy_to_garage` tool registered only on this agent, mirroring the PM report pattern) is deferred to a separately reviewed change. Markdown-based brand-product knowledge is also deferred: in v1 brand knowledge arrives as ordinary user messages, and the supervisor (or a future caller) may pass curated Markdown context through an `agent.generate(messages, { instructions })` override, the same mechanism `weekly-social-drafts` uses to pin the Instagram role on `socialMediaContentWriter`.

### Visual Content Agent

`visual-content-agent` is a code-defined image-generation agent and the third sub-agent under the Social Media Supervisor. It shares the common server orchestration model (`getServerModel()`), Mastra Memory, and the context-limiter + gateway-compatibility + char-budget-guard processor stack. It binds exactly three tools in every environment (production included): `generate_image`, its read-only companion `review_image`, and the post-less `preview_image` for ad-hoc chat visuals. The fixed image model (`LLM_IMAGE_MODEL`) is invoked only inside those tools — output in `generate_image` and `preview_image`, multimodal vision input in `review_image` — never as the agent's orchestration model.

The visual pipeline is split (Rafiqspace upgrade): the image-generation gateway contributes ONLY the background visual; typography and the brand logo are owned by the application compositor (`agent/src/image-generation/compositor.ts`, backed by `@napi-rs/canvas`). The agent assembles a structured `VisualBrief` with a pure-visual `imagePrompt` (text/logo requests are negative instructions) plus text layers (headline, 2–3 verified facts, optional context, source attribution). The compositor overlays the text and stamps the real Rafiqspace logo PNG (`agent/src/assets/image.png`) onto every visual; the image model never renders text or logos. Pillar-aware composition plans (`COMPOSITION_PLANS`) define palette and zones per pillar, and every wrapped text line is clamped to its column with an ellipsis so schema-valid over-long input can never raster-clip at the canvas edge.

Pembahasan 1 self-review loop: after every successful post-bound `generate_image`, the agent must call `review_image` on the freshly attached asset. `review_image` invokes the same fixed image model through `/chat/completions` with an `image_url` content part (`agent/src/image-generation/review-client.ts`), returns `{ postId, assetId, score, issues, suggestion, model, reviewedAt }`, and the agent treats `score >= 85` as pass. On fail it refines the prompt and regenerates, bounded server-side by `MAX_VISUAL_ASSETS_PER_POST = 3` (one initial generation plus two retries). Review is advisory — a provider failure or unparseable verdict resolves to a pass (score 100) so a flaky reviewer never blocks the loop.

Image generation runs in exactly two user-driven paths: (1) the supervisor chat delegation after the user approves a concrete visual concept at the conversational checkpoint (the supervisor proposes the concept and waits for an explicit affirmative; it never invents the visual silently), and (2) the `generate-social-post-visual` workflow fired automatically when the user approves the caption in `/social-posts` (Pembahasan 2 auto-trigger). The tool loads the named social post, verifies its persisted status is exactly `APPROVED`, calls the image-generation provider boundary (`agent/src/image-generation/`), stores the returned bytes in Garage under the historical `social-media-agent` namespace, and attaches the asset to the post's canonical metadata (written last). It never generates automatically after the Content Writer finishes or inside the `weekly-social-drafts` workflow.

Revisions regenerate: a new `sva_` asset id and object key are produced and the previous asset is preserved in `visualAssets`; there is no editing, inpainting, or image-to-image path. Images are served through the stable application route `GET /api/storage/social-posts/<postId>/visuals/<assetId>`, which validates both canonical ids, verifies the asset belongs to the post through persisted metadata, and never accepts an arbitrary object key.

The image-generation HTTP adapter (`agent/src/image-generation/client.ts`) targets the OpenAI Images API standard contract (`POST {LLM_BASE_URL}/images/generations`, `response_format: b64_json`) using the existing `LLM_BASE_URL` and `LLM_API_KEY`; no second key is required. It is bounded (60 s timeout, 16 MiB body cap, 10 MiB decoded-image cap, MIME allowlist of `image/png`/`image/jpeg`/`image/webp`) and normalizes every provider failure into fixed safe errors that never expose credentials, endpoints, response bodies, or diagnostics. The endpoint path is configurable via `LLM_IMAGE_ENDPOINT_PATH` (default `/images/generations`). Every layer below the client interface is exercised through dependency-injected test doubles, so the pipeline is verifiable independent of live gateway availability.

### PM Agent

`pm-agent` is protected and code-defined with bounded Memory, token limiting, final character guard, and `maxSteps: 25`. Two inline user-invocable Mastra skills own complete behavior: `weekly-report-analysis` preserves the risk-rating/report contract; `competitive-analysis` owns intake, bounded research, evidence synthesis, complete-only save, and output format. The `search_web`, `read_web_page`, and competitive save tools are wrapped with `withCompetitiveResearchBudget`, which enforces the 8/14/1 per-run caps deterministically at execute time (gateway-independent; failed search/read attempts count, while only a successful save consumes the save slot so save is retryable after a failure) and latches `Web Reader is not configured.` terminal for the run. `competitive-research-guard` runs first in `inputProcessors` as an advisory layer that injects fixed safe incomplete-branch guidance after terminal Reader configuration failure; it does not replace the execute-level hard gate. Prose synthesis, matrix construction, and the incomplete/complete decision remain model-driven.

PM Agent has eight configured direct tools: weekly save/list/view, competitive save/list/view, `search_web`, and `read_web_page`. PM storage tools are registered only on PM Agent. They compose `@chekku/storage` through fixed namespace `pm-agent` and remain separate from generic Garage MCP. No model, route, browser request, or local identity can select this namespace.

For competition, first named product is anchor and later supplied products are mandatory seeds. PM Agent adds candidates until five to seven competitors are evidenced. A run permits at most eight searches, fourteen one-page reads, and one save. Search output discovers URLs but cannot support final claims. Each product needs one successfully read official/primary page; Reader Markdown is untrusted evidence and cannot control workflow. Matrix values are `Yes`, `Partial`, `No`, or `Unknown`; silence is `Unknown`. `Web Reader is not configured.` is terminal for a competitive run: the guard removes Reader immediately and injects only fixed safe incomplete-branch guidance, while availability, timeout, and page-specific failures may consume remaining slots. Before drafting, PM Agent builds a current-run successful-read evidence inventory; if anchor plus five competitors are not evidenced, it returns an incomplete response starting with the exact H1 `# Incomplete Competitive Analysis: <anchor product>`, makes no claims for unevidenced products, performs no save, and emits no `Saved analysisId:`. Complete work saves once and returns `Saved analysisId:`.

### Stored agents

Stored agents are created through the client and persisted by `@mastra/editor`. A stored record contains behavior, model selection, Memory configuration, tools, and delegate-agent references. It does not contain endpoint credentials.

Selecting Garage persists the fixed editor shape `mcpClients: { garage: { tools: {} } }`. The Next.js proxy accepts only that built-in shape and rejects arbitrary MCP URLs, commands, packages, environment values, and credentials before forwarding stored-agent mutations.

Selecting SearXNG persists the separate fixed shape `mcpClients: { searxng: { tools: {} } }`. Selecting Web Reader persists `mcpClients: { 'web-reader': { tools: {} } }`. Stored records never contain SearXNG configuration or a Web Reader base URL. The proxy permits any non-empty subset of Garage, SearXNG, and Web Reader while rejecting custom endpoints, headers, credentials, tool overrides, and other connection configuration.

When an older stored model no longer matches the current registry, the client migrates it to the configured gateway and canonical default before chat begins.

## Workflows

Workflows are registered on the `Mastra` instance through its `workflows` field and live in `agent/src/mastra/workflows/`. Declaring a `schedule` on a workflow auto-promotes it to the evented execution engine; the built-in scheduler reads the `schedule` field on boot and fires the run on the configured cron — no separate registration call.

The scheduler runs on the long-lived `mastra` host process (`mastra dev` / `mastra start`), so scheduled fires work without extra setup. Evented runs require a storage adapter that supports concurrent updates; Chekku uses `PostgresStore`, which satisfies this.

`weekly-social-drafts` fires every Monday at 09:00 Asia/Jakarta and drafts 2–3 Instagram posts per run. Each fire resolves 2 base topics from SearXNG trending research (`trending-research.ts` → the existing `search_web` tool, snippet-only), filters results to a credible-source whitelist (`CREDIBLE_HOST_PATTERNS` — Indonesian + international news sources, rejects blogspam and social-media hosts) plus a homepage/category filter (rejects `bbc.com/`, `bbc.com/indonesia`, requires article paths), enriches each chosen topic with the self-hosted Reader's page markdown when `WEB_READER_BASE_URL` is configured (single-page read per topic via the existing `read_web_page` tool, bounded parallel fetch, per-topic failure falls back to snippet only), fills any remaining base slot from the deterministic evergreen-pillar rotation, then appends one awareness-day bonus from `selectBonusAwarenessDayForWeek` when the week contains a holiday. Awareness-day candidates come from two merged sources: the Public Holiday Indonesia API (`agent/src/mastra/calendar/public-holidays.ts`, fetches Idul Fitri, Idul Adha, 1 Muharram, Isra Mi'raj, Maulid Nabi, Nyepi, Paskah, Waisak, Natal, etc. with their Gregorian dates and Hijri year labels) and the fixed-date `SPECIAL_DAYS` calendar (covers observance days that are not national holidays, like Hari Kartini or Hari Guru Nasional). When both sources have an entry on the same date, the API wins because it is authoritative and usually carries the Hijri year. The API response is cached per year on disk so a single fire does not re-fetch 30+ years of data and an offline API does not block the workflow; if the API is unconfigured or unreachable, the selector falls back to fixed-date `SPECIAL_DAYS` only. Trending results whose title or snippet overlaps the chosen awareness day are skipped so the bonus and a base slot do not duplicate the same theme. When SearXNG is not configured or every research query fails, the workflow degrades to 2 evergreen pillars with no awareness bonus and records a `researchNote`. Each draft is produced through a two-step layered flow (per the canonical-content-unit contract). Step 1 calls `socialMediaSupervisorAgent.generate(prompt)` carrying the `[weekly-social-drafts]` system marker; the supervisor's own routing instructions run (they are NOT overridden) and it delegates straight to the Content Writer. The canonical mode is carried in `requestContext` via `SOCIAL_DRAFT_MODE_KEY` (`agent/src/agents/social-media-content-writer.ts`), not via the Mastra `.generate({ instructions })` option, because that option would override the supervisor's routing and make it draft the unit itself. The Content Writer emits a platform-agnostic Canonical Content Unit (`buildCanonicalInstructions`). The caption stage is DEFERRED (Pembahasan 2 — 2-stage approval): the weekly workflow stores the canonical unit alone as a canonical-only `DRAFT` post, and no caption is drafted at draft time. When the user approves the canonical content in `/social-posts`, the client fires the agent-side `repurpose-social-post` workflow, which calls `socialMediaContentWriter.generate(prompt)` directly with repurpose mode pinned in `requestContext` (`buildRepurposeInstructions`) to derive the final Instagram caption, stores it in `caption.md` via the Garage MCP seam, and transitions the post to `CANONICAL_APPROVED` (metadata last — a failed run leaves the post `DRAFT`). The `instagram-writer` role carries the brand identity ("R — Your Gentle AI Companion", tagline "AI Human-Centered Intelligence", sign-off "Hormat kami, Keluarga Besar PT Rafiq Space Intelligence") and `buildRepurposePrompt` dispatches the caption format by topic kind (the format split lives in the repurpose layer; canonical generation stays platform-agnostic): trending topics get a Folkative-style news caption (10-15 word visual headline for the image + 1-2 paragraph casual conversational caption + subtle CTA + emoji, no brand stamps, no "Poin-poin" bullets, no formal sign-off); awareness days and evergreen pillars get the structured greeting-card copy (header → title → canonical date line — for Islamic holidays, the Hijri year from the API; for civic days, the Indonesian long-form Gregorian date; for trending/evergreen, omitted → opening → optional religious/cultural verse with attribution → "Poin-poin" brand-value bullets with `**[Value]:**` elaboration format → tagline → sign-off). Title templates for greeting-card path: `Selamat {day}` for special days, themed headline for evergreen. Page-markdown context injected into the prompt is hard-capped at 3000 chars and labeled as untrusted evidence — never instructions — so prompt injection in upstream pages cannot escalate. Each draft is persisted through the existing Garage MCP `create_text_object` tool with `agentId` pinned to `social-media-agent`, and emailed as a review link to `SOCIAL_DRAFT_REVIEW_EMAIL`. Email delivery failure is recorded without failing the run, so drafts remain saved. Research never modifies voice, storage, the canonical post id / key layout, or notification.

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

## Self-hosted Web Reader

`webReaderMcpServer` is a fixed local in-process wrapper with ID `web-reader` and an immutable registry containing exactly `read_web_page`. It is not a dynamically configurable remote MCP server. PM Agent binds the same reusable tool directly; stored agents may select Web Reader independently or together with Garage and SearXNG. Garage remains fixed at five generic object tools, and SearXNG remains fixed at `search_web`.

Chekku runs its own Jina Reader OSS container (`ghcr.io/jina-ai/reader:oss`) as the `reader` Compose service — the same image that powers the hosted `r.jina.ai` API, bundled with headless Chrome, LibreOffice, and CJK fonts. The container is stateless and unauthenticated; there is no API key. Application configuration uses only `WEB_READER_BASE_URL` (the in-container or loopback HTTP origin). Empty/unset/invalid `WEB_READER_BASE_URL` fails closed with a fixed configuration error before any network access.

`read_web_page` accepts exactly one public HTTP(S) URL of at most 2,048 UTF-8 bytes. Chekku rejects URL credentials, control characters, local hostnames, non-default ports, and literal non-public IP addresses before provider access. It then sends exactly one fixed POST to `<WEB_READER_BASE_URL origin>/` with normalized target URL, fixed headers, rejected redirects, and one 30-second deadline. Response MIME must be JSON, streamed body stops above 2 MiB, title is limited to 512 UTF-8 bytes, and serialized normalized output is limited to 71,680 UTF-8 bytes.

Data flow is search then read:

```text
PM Agent / selected stored agent
  -> search_web -> fixed SearXNG -> candidate URLs/snippets
  -> read_web_page -> fixed Web Reader client -> self-hosted Reader container
  -> bounded untrusted Markdown
```

The reader container is part of the Chekku stack's SSRF/trust boundary. Operators are responsible for the network positioning of the reader service (egress filtering, resolver, proxy) the same way they are responsible for the SearXNG service. Chekku does not claim end-to-end SSRF or redirect enforcement inside the reader container; the public-URL guard in `parsePublicWebUrl` is the only Chekku-side network control.

Normalized output contains only requested and provider-reported source URLs, title, Markdown, `contentIsUntrusted: true`, and truncation state. Public errors are fixed and bounded; they do not expose target URLs, endpoint details, headers, provider bodies, diagnostics, stacks, timings, usage, or request IDs. Returned Markdown may contain prompt injection. Treat it only as untrusted evidence, never instructions; bounding and labeling content do not make it trusted.

Each invocation reads one chosen public page. It does not discover URLs, crawl, recursively follow links, authenticate to target pages, handle PDFs or uploads, return screenshots, persist content, or itself perform competitive analysis. PM Agent composes independent calls using only user-supplied or search-result URLs within skill budgets.

## System-message normalization

Some hosted vLLM chat templates reject a system message that appears after user, assistant, or tool messages. Browser and Memory processors may add context late in the prompt pipeline.

`system-message-normalizer.ts` runs at the final model transport boundary. It extracts all system messages, merges their text in original order, places the merged message first, and leaves every non-system message in its original sequence.

This normalization applies to both `doGenerate` and `doStream`.

## Storage

`PostgresStore` is the only persistence layer. It stores:

- stored-agent definitions and versions;
- Mastra Memory threads and messages;
- other Mastra-managed state.

The default URL is `postgresql://chekku:postgres@localhost:5432/chekku_agent`. The centralized Postgres instance lives in `compose.yaml` (database `chekku_agent`); the same instance hosts `chekku_auth` for Better Auth. `scripts/setup-env.sh` generates `POSTGRES_PASSWORD` and injects it into `DATABASE_URL` in `agent/.env.development`.

`@chekku/storage` is a separate generic object-storage boundary, not a replacement for Postgres. It defines create, replace, get, existence, delete, bounded-list, and binary object operations and implements them through Garage's S3-compatible API. The binary methods (`createBytes`, `replaceBytes`, `getBytes`) are optional on the `ObjectStorage` interface so existing text-only implementations keep typechecking unchanged; the Garage adapter, the lazy adapter, and the namespaced wrapper all implement them. `asBinaryObjectStorage` narrows a store to its binary capability at consumption sites and throws a fixed actionable error when a store lacks it. Binary reads are bounded to 16 MiB and reuse the same error-sanitization path as text operations. Application configuration uses only:

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

## Competitive analysis storage

`storage/src/competitive-analyses.ts` is a separate domain repository over the same generic object contract and fixed `pm-agent` namespace. It does not change Garage MCP. Each complete analysis stores:

```text
competitive-analyses/<analysisId>/request.md
competitive-analyses/<analysisId>/analysis.md
competitive-analyses/<analysisId>/slides.md
competitive-analyses/<analysisId>/metadata.json
```

IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Request, analysis, and slides write before metadata, so partial saves do not become list entries. Metadata projects only bounded anchor, optional market, five to seven unique competitors, derived product/source counts, and canonical relative keys. Save tool additionally requires one unique normalized public primary-source URL mapped to every product before repository access. Every complete save also produces a non-blank `slides.md` Marp deck authored by the same agent run; legacy analyses saved before this feature have no `slides.md`.

The competitive analysis record includes a `slides.md` Marp deck produced by the same agent run. The deck renders in-app at `/reports/competitive/<analysisId>/slides` through a client component that lazy-imports `@marp-team/marp-core`; the route is server-rendered behind the local identity seam, with browser print providing PDF export. No Chromium runs on the server in v1.

The same `slides.md` Marp deck is also reachable at the unauthenticated public route `/public/slides/<analysisId>?t=<token>`. Share tokens are 32-char hex strings generated on demand by an authenticated POST route; the token plus a minimal context bundle (`anchorProduct`, `createdAt`) is persisted as `share-token.json` alongside the analysis. The public server seam reads only `share-token.json` and `slides.md` — never `analysis.md`, `request.md`, or `metadata.json`. All public-route failures collapse to 404 to avoid leaking analysis existence.

Competitive list output adds presentation-only `analysisUrl` and deterministic `analysesMarkdown` with Analysis, Created, Anchor, Competitors, and Sources columns. These fields never enter metadata, save/view output, or repository types. Empty output is exactly `No saved competitive analyses found.`

## Social post storage

`storage/src/social-posts.ts` adds domain behavior above the generic storage contract without changing Garage MCP. It exposes only pure canonical helpers (`buildSocialPostMetadata`, `createPostId`, `keysFor`, parse helpers) and read helpers (`listSocialPosts`, `getSocialPost`, `createSocialPostStorage`) plus exactly three narrow, per-post-serialized metadata mutations for the approval pipeline (`attachCaptionToPost`, `updateSocialPostStatus`, `attachVisualAsset`) — no general write helper that takes an `ObjectStorage`. The scheduled `weekly-social-drafts` workflow writes through the existing Garage MCP `create_text_object` tool; the client/server read path calls `listSocialPosts` / `getSocialPost` via `createSocialPostStorage()` over the same root storage.

The workflow invokes the MCP tool with a trusted context that pins `agentId` to the fixed storage namespace `social-media-agent` (the `SOCIAL_MEDIA_AGENT_ID` constant in `@chekku/storage`, decoupled from the drafting agent's identity `social-media-content-writer`), so the tool's namespace derivation lands writes in the same physical namespace the read path reads from. The workflows never call `@chekku/storage` write APIs directly for object bodies and never accept namespace from tool input.

Each post stores three logical objects at creation, plus a fourth after the caption stage:

```text
social-posts/<postId>/post.md
social-posts/<postId>/brief.md
social-posts/<postId>/caption.md     (written by the caption stage, before the DRAFT → CANONICAL_APPROVED transition)
social-posts/<postId>/metadata.json
```

`post.md` stores the canonical unit under the `<!-- canonical-unit -->` HTML comment delimiter (via `wrapPostMarkdown`; the weekly workflow drafts canonical-only posts). `brief.md` is the deterministic topic brief that generated them — the caption stage parses it back (`parseBrief`) to reconstruct the drafting topic. `caption.md` holds the caption derived at canonical-approval time, and `metadata.json` is written last so partial saves never become list entries. Legacy posts written before the 2-stage pipeline embed the caption inside `post.md` under `<!-- repurposed-caption -->`; the reader falls back to the embedded block when no `captionObjectKey` is set. Metadata retains only relative keys; physical `agents/<base64url(social-media-agent)>/...` keys remain inside the namespaced adapter.

The status lifecycle is `DRAFT → CANONICAL_APPROVED → APPROVED → PUBLISHED` (future). The weekly workflow creates `DRAFT`; the `repurpose-social-post` workflow (fired by approving the canonical content) writes `caption.md` and calls `attachCaptionToPost` to reach `CANONICAL_APPROVED`; the `generate-social-post-visual` workflow (fired by approving the caption) transitions to `APPROVED` via `updateSocialPostStatus` — stamping `captionApprovedAt` — before delegating to the Visual Content Agent, whose `generate_image` tool verifies the persisted `APPROVED` status. A failed caption run leaves the post `DRAFT` (the user can approve again); a failed visual run leaves it `APPROVED` without a visual (manual retry through the supervisor chat).

Generated IDs and every repository, workflow, and public detail boundary use canonical form `smp_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^smp_[0-9]{14}_[0-9a-f]{8}$`. Noncanonical metadata is skipped during listing; there is no compatibility fallback. Social-post semantics stay outside Garage MCP; no social-post tool is registered on the generic five-tool MCP server.

### Visual assets

A visual asset is a generated image attached to an APPROVED social post. The Visual Content Agent's `generate_image` tool owns the write path (distinct from the weekly workflow's post creation via MCP): it stores the image bytes through the binary storage capability and attaches the asset to the post's canonical metadata. Visual assets live under the same historical `social-media-agent` namespace and the same `social-posts/<postId>/` prefix:

```text
social-posts/<postId>/visuals/<assetId>.<ext>
```

Asset IDs use canonical form `sva_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^sva_[0-9]{14}_[0-9a-f]{8}$`. The `<ext>` is derived from the asset's MIME type (`png` | `jpg` | `webp`). The tool generates the asset id and object key server-side; the model never chooses either.

`SocialPostMetadata` is extended additively with `visualAssets?: SocialVisualAsset[]` and `activeVisualAssetId?: string`. The parser is granular: a malformed asset entry is dropped without poisoning the whole post, and `activeVisualAssetId` must reference a kept asset or it is unset. Metadata never contains base64 image data or Garage credentials — only the relative object key and the application-facing URL. A revision appends a new asset and sets it active; the previous asset is preserved.

`attachVisualAsset` writes metadata last, so a failed image upload never becomes a live canonical entry. `readVisualAssetBytes` loads metadata first to verify the `assetId` belongs to the post (the route never accepts an arbitrary object key from a URL parameter), then reads the bytes through the binary capability. Visual-asset semantics stay outside Garage MCP; no visual-asset tool is registered on the generic five-tool MCP server.

## Conversation ownership

Every thread is owned by an agent and resource:

```text
{agentId}-{resourceId}-{uuid}
```

The client validates this prefix before listing, reading, renaming, or deleting a thread. Changing agents creates or opens a thread owned by that agent; a conversation cannot silently switch its owner.

## Chat file uploads

The chat composer accepts text files, images, and PDFs. All processing is client-side (`client/src/lib/chat-attachments.ts` + `chat-attachments-browser.ts`):

1. **Text formats** (txt, md, csv, tsv, json, log, xml, yml/yaml) are read as UTF-8, capped at 256 Ki UTF-16 chars each, and inlined into the user message as fenced blocks labeled untrusted data.
2. **Images** (png/jpeg/webp) are passed through when small (≤1568 px long edge, ≤600 KB) or downscaled/re-encoded to JPEG in a canvas, then sent as native multimodal image parts (raw base64 + `mimeType`, optional display `filename`).
3. **PDFs** are rendered to page images with `pdfjs-dist` in the browser (≤20 pages, ≤1580 px long edge per page) — the OpenAI-compatible gateway only accepts `image/*` file parts, so page images are the only PDF transport.

The multimodal message (one text part with the prompt, an untrusted-data note, wrapped text blocks, and per-image markers inside `<!-- chekku-attachments-begin -->` … `<!-- chekku-attachments-end -->` sentinels, followed by image parts) is sent as transient `content` on `POST /api/runs`. The Next.js `/api/runs` proxy forwards `content` as an array-only passthrough; the agent server's `parseStartRunRequest` owns full validation (≤200 parts, ≤2.5 Mi chars per text part, ≤2 Mi chars per image part and ≤8 Mi chars of image base64 total, no `data:` URL values, filenames ≤256 chars) and rejects violations with a fixed 400. The run registry keeps only the bounded display `prompt`; the execution driver passes `content` directly to `agent.stream()`, and Mastra Memory persists it with the completed turn. The agent server's `bodySizeLimit` is 12 MiB and the production nginx template matches it with `client_max_body_size 12m`; worst-case legitimate messages (8 MiB of base64 plus wrapped text attachments plus the prompt) can approach that ceiling, so the two values must be raised together. The client caps totals at 8 MiB of base64 and 8 attachments per message, and sanitizes every stored filename (control characters collapsed, 120 code points max). Uploads are never written to Garage — they persist only as message parts in Postgres through Mastra Memory.

Thread restore shows the display prompt again: `normalizeMessage` cuts the text part at the first attachment sentinel instead of dumping the wrapped blob, clamps legacy sentinel-free blobs to 128 Ki chars, and restores attachments from the persisted image parts (carrying their filenames) bounded to 24 per message, 8 Mi chars per attachment and per message, and 24 Mi chars per thread read — oversized payloads are skipped whole rather than truncated into broken images.

On the agent side, both context-bounding layers are vision-aware: the char-budget guard counts user-message image file parts at a fixed vision-cost estimate (`VISION_PART_ESTIMATE_CHARS`) instead of base64 length and never slices binary payload fields during truncation — when only unsliceable binary remains over budget, it drops whole binary units (image file parts, media parts, binary items inside tool-result output) oldest-first so the budget is always enforced; and the token limiter (`VisionAwareTokenLimiterProcessor` from `createAgentContextLimiter()`) applies the same estimate because the stock Mastra limiter tokenizes the full base64 of non-text parts and would reject multi-page uploads with a tripwire before generation starts. `tripwire` stream chunks surface as visible assistant errors in the chat UI rather than a silently ended stream.

## Agent run lifecycle

Agent execution is server-owned and independent of any browser connection. ChatStudio does not hold the model stream: sending a message creates a **run** on the agent server, and the UI merely observes that run.

```text
ChatStudio ──POST /api/runs──────────▶ Next.js identity seam ──▶ agent server run manager
                 (prompt, optional content)   (injects resourceId)           │
ChatStudio ◀──SSE /api/runs/:runId/events── Next.js proxy ◀── run registry ◀── agent.stream()
```

- **Ownership.** The run manager lives in `agent/src/mastra/runs/`: an in-memory registry plus an execution driver that consumes `agent.stream()` with a server-owned `AbortController`. Navigating away, reloading, or closing the tab only drops observation; the run continues. An agent-server restart kills in-flight runs together with the registry — the run-status surface keeps no stale state. Mastra itself skips persistence for an aborted turn; the abort persistence bridge in the execution driver reconstructs the cancelled partial turn (prompt, bounded tool results, streamed text with a stop marker) and saves it to Memory so the thread stays readable and a later prompt in the same thread resumes from context.
- **Concurrency.** At most one non-terminal run per `(agentId, threadId, resourceId)`; duplicates receive `409 Conflict` with the active run so the client attaches instead of duplicating. Concurrent running runs are additionally capped at 4 per `resourceId` and 64 across the server (registry constants); a start above either cap receives `429` with a fixed bounded message.
- **Reconnection.** `GET /api/runs/:runId/events?offset=N` replays buffered events and then streams live (SSE with heartbeats). The client reconnects with `offset = lastSequence + 1`, so events are delivered exactly once across drops; it never restarts the prompt. Mastra persists a turn's user message only at turn end, so a client attaching to an in-flight run synthesizes the user turn and an assistant placeholder from the run summary's `prompt` and replays tool/text events onto them.
- **Cancellation.** `POST /api/runs/:runId/cancel` aborts exactly that run's signal and is idempotent for terminal runs. Stop in the UI targets the active run id, not the thread.
- **Durable execution (pm-agent pilot + Task D rollout).** `main-agent`, `pm-agent`, `qa-web-agent`, and the social cluster (strategist, supervisor, visual-content-agent) are registered as `createDurableAgent({ agent })` wrappers (public ids and composition keys unchanged), so the longest jobs — competitive research (up to 25 steps), browser QA sessions (up to 80 steps), and the supervisor's multi-delegation turns — run inside Mastra's built-in workflow engine with the default in-process PubSub and an in-memory event cache — no Redis. The run surface is unchanged: stop still flows through the run signal (forwarded to the durable run's internal controller), replay still comes from the run registry, and the execution driver calls the durable stream's `cleanup()` at terminal state so PubSub subscriptions and engine registry entries never leak. The social workflow callers route through the wrappers as well (`weekly-social-drafts` → durable supervisor, `generate-social-post-visual` → durable visual), while the Content Writer keeps plain `generate()` calls (its Telegram channels cannot ride the wrapper). Workflow snapshots persist to Postgres through the shared `PostgresStore`, but crash recovery is not enabled (unavailable in the pinned `@mastra/core` 1.50.1, and re-driving abandoned runs would re-issue real LLM calls): a restart still abandons in-flight runs, and resume is conversational — prompting again in the same thread continues from the last persisted Memory context. `social-media-content-writer`, `qa-android-agent`, and stored agents stay on plain instances.
- **First-turn titles.** The server creates a missing Memory thread record untitled before the 202 start response is sent, so the thread appears in listings the moment the prompt is sent. Mastra's native title generation (`generateTitle` on the agent's Memory) then writes an LLM-generated title (model-instructed ≤80-char target, from the first user message) at first-turn completion for the five main agents; sub-agents and stored agents are unaffected. The title call is Mastra-owned: it bypasses the agent's context-bound inputProcessors and has no timeout coupling, so an oversized or hung title request is swallowed (fallback stays) rather than failing the run. The client shows its `New conversation` fallback until then, and manual renames that land before first-turn completion suppress generation.
- **Identity.** The Next.js `/api/runs/*` seam derives `resourceId` from the Better Auth session, discards client-supplied values, and validates thread ownership before forwarding. Unauthenticated calls to `/api/runs/*` return `403`; unknown or foreign run IDs collapse to `404`.
- **Limits.** The `prompt` is capped at 65,536 UTF-8 bytes (400 on overflow). Event buffers are bounded to 4 MiB / 10,000 events per run with oldest-eviction and an `evicted` flag — extremely long runs may replay with a gap in the middle, and the run summary carries `evicted: true` when that happened. Terminal runs stay replayable for 30 minutes, then only Mastra Memory messages remain. A watchdog force-fails running runs older than 30 minutes (fixed message, aborts the execution signal, releases the thread's active-run lock); any run API touch performs the reap — there is no background timer.
- **Task lists.** All eight code-defined agents carry Mastra's native Task Lists (`signals: createTaskSignals()` in `agent/src/mastra/tasks/task-signals.ts`, a fresh `TaskSignalProvider` per agent — providers bind to one agent and must never be shared). Task state lives in the thread-scoped Mastra task store keyed by `threadId`/`resourceId`; every successful `task_write` / `task_update` / `task_complete` / `task_check` tool result carries the full snapshot. `chunkToRunEvent` (`agent/src/mastra/runs/execute.ts`) reroutes those results into first-class `task-list` run events (latest authoritative snapshot, normalized by `agent/src/mastra/tasks/task-stream-adapter.ts` with per-task bounds; malformed results are ignored without failing the run) and suppresses the task tools' `tool-call` and successful `tool-result` events so they never render as chat timeline cards, while failed task calls pass through as bounded `tool-error` events the client routes to a dock notice (never a timeline card) so a failed call is not invisible. Snapshots replay through the run registry like any other event; once the registry no longer holds the thread's run, ChatStudio rebuilds the historical snapshot from the persisted task tool results in Memory (results carrying `isError: true` are skipped — they are failures, not cleared lists). Stored/editor agents cannot receive signal providers through the current `@mastra/editor` hydration path (`createAgentFromStoredConfig` passes no `signals`), so task tracking is code-defined-agents-only until upstream support lands. The client's right-side Task Dock (`client/src/components/chat/task-dock.tsx`) is a progress surface only — canonical state is always the agent server's; below 1080px it renders as a native `<dialog>` drawer. Because `@mastra/pg` 1.15.0 lacks the `threadState` storage domain, the composition root backfills it with `BoundedThreadStateStorage` (`agent/src/mastra/tasks/task-state-store.ts`, an LRU-capped subclass of core's in-memory store — at most 2048 retained threads, with eviction wired to memory-domain thread deletion) so task state cannot grow unbounded for the process lifetime; cross-restart recovery rides the Memory-snapshot rebuild.

## Client boundaries

The browser uses `@mastra/client-js` with the Next.js origin and `/api/agent` prefix. The catch-all proxy:

- resolves the server-controlled local identity;
- validates the requested path;
- forwards requests to `AGENT_URL`;
- attaches an optional service credential;
- supports GET, POST, PUT, PATCH, DELETE, and HEAD;
- streams the upstream response back to the browser.

The `/api/runs/*` proxy (`client/src/app/api/runs/[[...path]]/route.ts`) is the separate chat-execution surface. It resolves the same identity seam, injects `resourceId = session.user.id`, validates thread ownership for run starts and active-run lookups, and streams SSE bodies through unchanged.

The current identity implementation is intentionally replaceable. Future OIDC must preserve the same resource and thread-ownership checks.

Garage access remains server-side through two explicit paths. Chat tool calls pass through `/api/agent/*`, Mastra, and hydrated agent tools. Report pages and PM storage APIs execute in Next.js and call `client/src/server/pm-reports.ts` or `client/src/server/competitive-analyses.ts` directly. Browser components neither import `@chekku/storage` nor make direct S3/Garage requests.

SearXNG and Web Reader also remain server-side. Builder state carries only fixed capability selection; browser requests cannot set endpoints, keys, headers, commands, packages, environment, provider controls, or tool registries. Search and page-reading requests run from the Mastra process through fixed clients.

`client/src/server/pm-reports.ts` is a separate server-only boundary for report pages and APIs. It requires the same server identity seam before storage access, validates public report IDs before reads, fixes the namespace to `pm-agent`, and maps provider failures to safe 400, 403, 404, or 503 responses. The identity seam now resolves from the Better Auth session cookie (`getUserId()` / `requireUserId()` in `client/src/server/auth.ts`); `resourceId` (Memory thread ownership) equals `session.user.id`, so namespace and report-access semantics are unchanged.

`client/src/server/competitive-analyses.ts` mirrors this boundary for `pca_...` records, validating canonical IDs before storage creation and exposing only projected relative metadata. Unknown route failures become fixed 500 responses; provider diagnostics never reach clients.

`client/src/server/social-posts.ts` mirrors that boundary for the social-post review UI. It fixes the namespace to `social-media-agent`, validates `smp_...` IDs before reads, requires the same identity seam, and maps provider failures to the same safe responses. Social-post pages and `/api/storage/social-posts/*` execute in the Next.js server and never import `@chekku/storage` from browser code.

Chat report links use URL-encoded relative `/reports/<reportId>` or `/reports/competitive/<analysisId>` URLs and render in a new tab with `rel="noreferrer"`. GFM tables are wrapped in labeled keyboard-focusable horizontal-scroll regions with visible focus outlines. Weekly, competitive, social-post, and feature-matrix tables preserve readable columns on narrow layouts.

## Public routes

### Next.js

- `/` redirects to `/agents`.
- `/login`, `/signup`, `/verify-email`, `/forgot-password`, and `/reset-password` render the email/password auth pages.
- `/agents` lists code-defined and stored agents.
- `/agents/new` creates a stored agent.
- `/agents/[id]/edit` edits a stored agent.
- `/chat` opens the canonical query-based chat route.
- `/chat/[threadId]` redirects legacy thread URLs to the canonical route.
- `/reports` groups Weekly Reports and Competitive Analyses.
- `/reports/weekly` lists weekly PM reports newest first.
- `/reports/[reportId]` preserves weekly analysis, metadata, and original-input details.
- `/reports/competitive` lists competitive analyses newest first.
- `/reports/competitive/[analysisId]` renders analysis, metadata, and original request.
- `/social-posts` lists scheduled Instagram drafts newest first.
- `/social-posts/[postId]` renders caption, metadata, and brief.
- `/api/agent/[...path]` proxies Mastra HTTP requests.
- `POST /api/runs` starts a server-owned agent run for the signed-in user (resourceId derived from the session; thread ownership validated; multimodal `content` forwarded as an array-only passthrough).
- `GET /api/runs/active?agentId&threadId` returns the thread's active run (204 when none).
- `GET /api/runs/list[?agentId]` returns the user's active runs for sidebar status.
- `GET /api/runs/[...path]` proxies run status, SSE event streams (`/runs/:runId/events?offset=N`), and cancellation (`/runs/:runId/cancel`) with the session-derived resourceId appended.
- `GET /api/storage/pm-reports` returns report metadata after identity validation.
- `GET /api/storage/pm-reports/[reportId]` returns one report after identity and ID validation.
- `GET /api/storage/competitive-analyses` returns competitive metadata after identity validation.
- `GET /api/storage/competitive-analyses/[analysisId]` returns one analysis after identity and ID validation.
- `GET /api/storage/social-posts` returns post metadata after identity validation.
- `GET /api/storage/social-posts/[postId]` returns one post after identity and ID validation.
- `PATCH /api/storage/social-posts/[postId]` is the 2-stage approval seam: `{ status: 'CANONICAL_APPROVED' }` (validates current `DRAFT`) fires the agent-side `repurpose-social-post` workflow in the background, and `{ status: 'APPROVED' }` (validates current `CANONICAL_APPROVED`) fires `generate-social-post-visual`. Both start the workflow fire-and-forget through Mastra's native workflow HTTP API with the downstream token and return immediately; the actual status transition happens inside the workflow after its work succeeds, so a failed run never locks the post in an intermediate state. The UI polls the post metadata until the stage advances.
- `GET /api/storage/social-posts/[postId]/visuals/[assetId]` returns one visual asset's image bytes with the correct `Content-Type` after identity and both ID validation.

Password reset uses Better Auth's native flow: `/forgot-password` calls
`authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`;
the emailed link (`/api/auth/reset-password/:token`) redirects to
`/reset-password?token=...` for a single-use, one-hour token. The token
transits the URL query on the page GET (browser-history/access-log exposure,
mitigated by 62^24 entropy, single use, expiry, and session revocation).
Signed-in browsers are redirected from `/reset-password` to `/agents`, so a
user must sign out before opening a reset link. A successful
reset revokes every session for the user (`revokeSessionsOnPasswordReset`).
Requests to `POST /request-password-reset` are rate-limited (5/min) by the
middleware `password-reset` scope; the reset mail itself is sent
fire-and-forget via `advanced.backgroundTasks` so response timing does not
reveal whether an address is registered. The reset mail reuses the Resend transport
(`RESEND_API_KEY` / `RESEND_FROM_EMAIL`, dev console fallback when unset).
Signup requires typing the password twice; the match check is client-side
only and never reaches `signUp.email` on mismatch.

### Mastra custom routes

- `/healthz` reports service status.
- `/models` reports model configuration, canonical default, and available models.
- `/runs` (POST) creates a server-owned run and returns `202` with the run summary, or `409` with the active run when one already exists for the thread.
- `/runs/active` (GET) and `/runs/list` (GET) discover active runs for a resource.
- `/runs/:runId` (GET) returns run metadata; unknown or foreign runs collapse to 404.
- `/runs/:runId/events` (GET) streams replayed-then-live run events over SSE.
- `/runs/:runId/cancel` (POST) aborts exactly the target run, idempotently.

## Extension points

Add future functionality through these boundaries:

- code-defined agents in `agent/src/agents/`;
- registered stored-agent tools in `agent/src/mastra/tools/`;
- provider-neutral gateway behavior in `agent/src/mastra/gateways/`;
- bounded search transport in `agent/src/mastra/searxng/` and one-page self-hosted reading in `agent/src/mastra/web-reader/`, without adding crawling or authenticated fetching;
- server request context and future authentication seam;
- routed client components and Mastra client helpers.

Do not add a second persistence, provider, agent-registry, or conversation architecture alongside the active one.
