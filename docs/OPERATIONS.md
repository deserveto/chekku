# Operations Guide

## Local setup

```bash
npm ci
npm run setup
npm run dev:sh
```

`npm run setup` copies env examples, generates local Garage and SearXNG secrets, and prompts for required values like `LLM_API_KEY`. `npm run dev:sh` starts local services and both workspaces without regenerating files; rerun `npm run setup` whenever environment requirements change.

The launcher provisions local Garage and SearXNG configuration, waits for both services to become healthy, then starts:

- Garage S3 API on `http://127.0.0.1:3900`;
- SearXNG on `http://127.0.0.1:8888`;
- Mastra on `http://localhost:4111`;
- Next.js on `http://localhost:3000`.

Web Reader runs as a `reader` Compose service (`ghcr.io/jina-ai/reader:oss`) — stateless, unauthenticated, no API key. `scripts/setup-env.sh` writes `WEB_READER_BASE_URL=http://127.0.0.1:8081` into `agent/.env.development`; compose uses `http://reader:8081`. Chekku calls it from the Mastra process only when `read_web_page` executes.

It exports these five Garage application values to both the Mastra process and the Next.js server boundary; do not copy generated credentials into tracked files:

```text
GARAGE_ENDPOINT
GARAGE_REGION
GARAGE_BUCKET
GARAGE_ACCESS_KEY_ID
GARAGE_SECRET_ACCESS_KEY
```

For search, the launcher exports only these two application values to the Mastra process:

```text
SEARXNG_BASE_URL
SEARXNG_API_KEY
```

The Next.js client process receives zero `SEARXNG_*` values. Only `SEARXNG_BASE_URL` and optional `SEARXNG_API_KEY` are SearXNG application configuration. `scripts/setup-env.sh` (run via `npm run setup`) also creates `searxng/.env.local` with a generated `SEARXNG_SECRET` and configuration hash for Docker Compose. Those values are private local service state: they are not copied to the agent or client application environments and must not be committed, logged, pasted, or configured as application variables.

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

Local `npm run dev:sh` supplies SearXNG configuration to the agent process. To use an external SearXNG instance instead, start Mastra without local provisioning and set:

```dotenv
SEARXNG_BASE_URL=https://search.example.com/private-path
SEARXNG_API_KEY=replace-with-server-only-reverse-proxy-token
```

The endpoint must use HTTP or HTTPS and must not contain URL credentials, query parameters, or a fragment. `SEARXNG_API_KEY` is optional; when present, Chekku sends it as a bearer token to fixed `/config` and `/search` paths. Keep both values server-side. An empty `SEARXNG_BASE_URL` leaves search unconfigured and makes `search_web` fail closed without preventing other agent features from starting.

Chekku self-hosts Jina Reader via the `reader` Compose service (`ghcr.io/jina-ai/reader:oss`). The container is stateless and unauthenticated — there is no API key. The agent reaches it via:

```dotenv
WEB_READER_BASE_URL=http://127.0.0.1:8081
```

`scripts/setup-env.sh` writes the canonical dev URL into `agent/.env.development`; in compose prod the service name resolves it (`http://reader:8081`). Empty/unset/invalid `WEB_READER_BASE_URL` does not block startup; `read_web_page` instead returns fixed `Web Reader is not configured.` error when invoked.

Migration note: the retired `WEB_READER_API_KEY` is inert if it lingers in an exported shell environment (nothing reads it), but remove it from shell rc files and CI secrets to avoid confusion — `scripts/setup-env.sh` cleans only the dotenv files.

#### Visual Content Agent (image generation)

The Visual Content Agent generates images on demand for an APPROVED social post through the fixed image model. Add server-owned configuration:

```dotenv
LLM_IMAGE_MODEL=gemini-3.1-flash-image
#LLM_IMAGE_ENDPOINT_PATH=/images/generations
```

`LLM_IMAGE_MODEL` is the fixed model id invoked by the `generate_image` tool; it never comes from tool or model input. Empty/unset fails closed with `Image generation is not configured.` without preventing other agent features from starting. `LLM_IMAGE_ENDPOINT_PATH` defaults to the OpenAI Images API standard path (`/images/generations`); override it only when the configured gateway exposes image generation under a different path. Both use the existing `LLM_BASE_URL` and `LLM_API_KEY`; no second key is required.

The image-generation HTTP adapter assumes the OpenAI Images API standard contract (`POST {LLM_BASE_URL}/images/generations` with `response_format: b64_json`). If the live gateway does not implement that contract, only `agent/src/image-generation/client.ts` needs adjustment.

Image generation is on-demand only. Ask the Social Media Supervisor to generate a visual for a specific approved post; it delegates to the Visual Content Agent, which calls `generate_image`. The tool verifies the post is `APPROVED` from persisted metadata, stores the image bytes in Garage, attaches the asset to the post's metadata, and returns the asset id plus the application-facing image URL. Revisions generate a new asset and preserve the previous one. Images are served at `GET /api/storage/social-posts/<postId>/visuals/<assetId>`.

The weekly workflow creates posts in the `DRAFT` status. To approve one for visual generation, open it on the social-posts detail page and use the Approve control, which issues `PATCH /api/storage/social-posts/[postId]` to transition `DRAFT → APPROVED` (the only permitted status mutation; `APPROVED` and `PUBLISHED` are terminal for this iteration). The `generate_image` tool rejects any post that is not `APPROVED`.

### `client/.env.local`

Mirrors `client/.env.example`; `npm run setup` generates `BETTER_AUTH_SECRET` and
wires `AUTH_DATABASE_URL` to the generated `POSTGRES_PASSWORD` (see
[Authentication](#authentication) below). `AGENT_SERVICE_TOKEN` is optional and
remains server-side.

```dotenv
AGENT_URL=http://localhost:4111
NEXT_PUBLIC_APP_URL=http://localhost:3000
AGENT_SERVICE_TOKEN=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AUTH_DATABASE_URL=postgresql://chekku:chekku@localhost:5432/chekku_auth
RESEND_API_KEY=
RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>
```

### Authentication

Chekku resolves identity from a Better Auth email/password session instead of a local development seam. The auth database (`chekku_auth`) is provisioned alongside `chekku_agent` by `scripts/postgres/init-databases.sh`.

`npm run setup` generates `BETTER_AUTH_SECRET` (a 32+ char random value) and writes `AUTH_DATABASE_URL` into `client/.env.local` using the same generated `POSTGRES_PASSWORD` used by the agent's `DATABASE_URL`. You do not type the secret or the password by hand.

After setup, apply the Better Auth schema once Postgres is running:

    docker compose up -d postgres
    npm run db:migrate

`npm run db:migrate` runs `@better-auth/cli migrate` against `AUTH_DATABASE_URL` and is safe to re-run.

Flow:

1. Sign up at `/signup` with email and password. Better Auth creates the user (unverified) and sends a verification email.
2. Verify the email. In production with `RESEND_API_KEY` set, the link is delivered through Resend. In local dev without `RESEND_API_KEY`, the verification URL is logged to the server console.
3. Sign in at `/login`. Better Auth rejects unverified accounts and resends the verification email on attempt.
4. Password reset: request a link at `/forgot-password`; the reset link is valid for one hour and can be used once. In dev the link is printed to the server console when `RESEND_API_KEY` is unset. A signed-in user must sign out before opening a reset link — session-carrying browsers are redirected from `/reset-password` to `/agents` (intentional, and asserted in the auth-rate-limit tests). The reset token transits the URL query (`?token=...`) on the page GET, so it can reach browser history and access logs; exposure is mitigated by the token's 62^24 entropy, single use, one-hour expiry, and full session revocation on use.
5. After verification and sign-in, the session cookie identifies the user. `getUserId()` / `requireUserId()` in `client/src/server/auth.ts` resolve `session.user.id` server-side; unauthenticated requests hit `/login` (or 403 on storage APIs).

**Production:** inject `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_DATABASE_URL`, and (for real email delivery) `RESEND_API_KEY` / `RESEND_FROM_EMAIL` via the hosting platform's secret or env configuration — not via committed files. Set `BETTER_AUTH_URL` to the real **HTTPS** origin so Better Auth issues `secure` session cookies. Run `npm run db:migrate` as a deploy release step.

#### Rate limiting

Signup, sign-in, verification-email resend, and password-reset requests are throttled in-process at 5 requests / 60s per scope. By default the limiter does **not** trust `x-forwarded-for` (it is attacker-controlled when the deployment is not behind a trusted reverse proxy that overwrites the header); every anonymous client shares one bucket per scope, which keeps the cap enforced but is stricter than ideal in dev.

Set `RATE_LIMIT_TRUST_PROXY=true` in `client/.env.local` only when Chekku sits behind a trusted proxy that supplies a verifiable client IP in `x-forwarded-for` (e.g. most managed Node hosts, Cloudflare, or an nginx config that sets the header to `$remote_addr`). Without that guarantee, leave it unset. The limiter is in-memory per process and intended for single-instance v1 deployments; distributed rate limiting is deferred.

## Health and model checks

```bash
curl http://localhost:4111/healthz
curl http://localhost:4111/models
curl --fail http://127.0.0.1:8888/healthz
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

## Agent runs

Chat execution is server-owned. Each prompt creates a run on the agent server that keeps executing after the browser navigates away, reloads, or closes; the chat UI reconnects by replaying run events and never restarts the prompt. One non-terminal run is allowed per agent/thread/resource — a second start receives `409` with the active run id.

Browser-facing endpoints (identity derived from the Better Auth session by the Next.js seam):

- `POST /api/runs` — start a run (`{ agentId, threadId, prompt }`); responds `202 { run }`, `409 { run }` when this thread already has an active run, or `429 { error }` when a concurrency cap is reached. The prompt is capped at 65,536 UTF-8 bytes (larger prompts get `400`). On a first turn the server creates the Memory thread record titled from the prompt (52-character truncation) before responding, so the thread shows up in the sidebar with a real name immediately, and the run summary in the response carries the `prompt`.
- `GET /api/runs/active?agentId&threadId` — the thread's active run, or `204`.
- `GET /api/runs/list[?agentId]` — active runs for sidebar status polling.
- `GET /api/runs/<runId>/events?offset=N` — SSE replay-then-live event stream; closes on the terminal event.
- `POST /api/runs/<runId>/cancel` — cancel exactly that run; idempotent.

Operational limits to know:

- The run registry is in-memory and single-instance. Restarting the agent server (dev or the `agent` container) kills in-flight runs; clients then see no active run and render the persisted Mastra Memory messages. Partial output of an interrupted run is not persisted (Mastra skips persistence on abort).
- Mastra persists a turn's user message only when the turn completes. While a run is in flight, the chat UI shows the user turn and live tool/text progress from the run record (`prompt` + event replay), not from Memory.
- Terminal runs stay replayable for 30 minutes; afterwards only Memory messages remain and tool-timeline detail for that run is gone.
- Run event buffers are capped (4 MiB / 10 000 events per run). Extremely long runs may replay with a gap in the middle; the run summary carries `evicted: true`.
- Concurrent running runs are capped at 4 per user and 64 across the server (registry constants, no environment override). A start above either cap receives `429` with a fixed message and the registry stays intact; a duplicate start on a busy thread still receives `409` so the client can attach.
- A running run older than 30 minutes is force-failed by the registry watchdog (fixed message `The run exceeded the maximum duration and was stopped.`), which aborts its execution signal and releases the thread's active-run lock even when the model gateway stream hangs. Any run API touch performs the reap; there is no background timer.
- Foreign or malformed run IDs collapse to `404`; unauthenticated calls to `/api/runs/*` return `403`.

## SearXNG search

Local SearXNG runs pinned image `docker.io/searxng/searxng:2026.7.18-277d8469c`. Compose publishes container port `8080` only on loopback at `127.0.0.1:8888`; the container health check calls its internal `http://127.0.0.1:8080/healthz`. Tracked `searxng/settings.yml` enables JSON search with POST requests, safe-search level 1, page limit 5, a 5-second engine request timeout, and a 10-second maximum engine request timeout.

`npm run setup` creates or reuses private `searxng/.env.local` with mode `0600`, generates the service secret once, and recreates configuration when tracked settings change. Do not copy that file into `agent/.env`; `setup-env.sh` writes `SEARXNG_BASE_URL=http://127.0.0.1:8888` to generated `agent/.env.development` and preserves a non-empty user-set `SEARXNG_API_KEY` from `agent/.env` (empty by default locally), the launcher strips all SearXNG values from the client process, and neither step prints private values.

`search_web` is search-only. It returns bounded titles, HTTP(S) URLs, snippets, source engines, optional category/score/published time, answers, corrections, and suggestions; it never downloads result-page content. Use it to discover candidate URLs, then pass one chosen public result to `read_web_page`. PM Agent's competitive skill owns selection, synthesis, and persistence; search does not.

Input and transport limits:

- query: trimmed, non-empty, at most 1,024 UTF-8 bytes;
- results: 1-20 requested, default 10; page: 1-5, default 1;
- optional targeting: at most 5 unique categories and 10 unique engines, validated through fixed `GET /config`; language must be supported;
- optional filters: safe search 0, 1, or 2; time range `day`, `month`, or `year`;
- fixed search request: `POST /search`, JSON only, redirects rejected, one 12-second deadline across config and search;
- upstream body: at most 2 MiB; normalized tool output: at most 131,072 UTF-8 bytes.

Output limits:

- at most 20 results; each HTTP(S) URL is at most 2,048 bytes, title 512, snippet 4,096, category 128, and list of source engines 8 unique names of 128 bytes each;
- at most 5 answers of 2,048 bytes each;
- at most 10 corrections and 10 suggestions of 512 bytes each;
- `truncated: true` when upstream entries are invalid, omitted, shortened, or removed to fit limits.

Errors are fixed and bounded for missing/invalid configuration, unavailable service, timeout, unsupported JSON, oversized or invalid responses, unsupported targeting, and invalid input. They do not disclose endpoint URLs, bearer tokens, search queries, upstream response bodies, diagnostics, headers, or request IDs.

To stop local Garage and SearXNG safely while preserving their named volumes:

```bash
docker compose --env-file storage/.env.local --env-file searxng/.env.local down
```

Do not add `--volumes` or run `docker volume rm` during normal shutdown or application/database reset. SearXNG cache and all Garage objects remain available for the next startup.

## Self-hosted Web Reader

Chekku self-hosts Jina Reader via the `reader` Compose service (`ghcr.io/jina-ai/reader:oss`) — the same image that powers the hosted `r.jina.ai` API, bundled with headless Chrome, LibreOffice, and CJK fonts. The container is stateless and unauthenticated; there is no API key. Chekku's `web-reader` MCP is a fixed local in-process wrapper around the reader container, never a dynamically configurable remote MCP server. There is no endpoint setting, provider selector, fallback provider, anonymous mode, or path back to the hosted `r.jina.ai` service.

PM Agent has `search_web` and `read_web_page` directly. Stored agents may select SearXNG and Web Reader independently or together. Normal flow:

```text
PM Agent / selected stored agent
  -> search_web -> fixed SearXNG -> candidate URLs/snippets
  -> read_web_page -> fixed Web Reader client -> self-hosted Reader container
  -> bounded untrusted Markdown
```

Self-hosted trust boundary:

- the reader container is part of the Chekku stack's SSRF/trust boundary, like Garage and SearXNG;
- Chekku controls the reader container; the container controls its own outbound network;
- operators are responsible for the network positioning of the reader service (egress filtering, DNS resolver, proxy);
- Chekku does not claim end-to-end SSRF or redirect enforcement inside the reader container;
- the public-URL guard in `parsePublicWebUrl` is the only Chekku-side network control;
- **intra-network oracle**: the reader endpoint is unauthenticated on the Compose network (`http://reader:8081`), so any peer container can POST URLs to it directly, bypassing `parsePublicWebUrl` — and the image bundles headless Chrome, making it a richer fetch oracle than SearXNG. This is consistent with the shared-`chekku-network` trust domain (any peer can also reach Garage and Postgres), but on a host running untrusted containers, isolate the reader onto a dedicated Compose network that only the agent joins;
- do not submit signed, OAuth, password-reset, or otherwise secret-bearing URLs.

`read_web_page` accepts one public HTTP(S) URL at most 2,048 UTF-8 bytes. It reads one chosen page only: no search, crawling, recursive link following, authenticated pages, PDFs, uploads, screenshots, persistence, or built-in competitive orchestration. Fixed transport sends one `POST <WEB_READER_BASE_URL origin>/` request, rejects redirects, uses one 30-second deadline, performs no retry, accepts JSON only, and stops response body above 2 MiB. Normalized title is at most 512 UTF-8 bytes; serialized tool output is at most 71,680 UTF-8 bytes with UTF-8-safe Markdown truncation.

Safe failures cover missing configuration, disallowed URLs, cancellation, timeout, provider availability, unsupported format, oversized body, and invalid response. They do not include target URL, query string, fragment, endpoint, headers, provider body, status details, diagnostics, stack, timing, usage, or request ID. Do not add these details to logs or tickets.

Returned Markdown may contain prompt injection. Output always marks `contentIsUntrusted: true`; treat content only as untrusted evidence, never instructions. Size bounds and labeling are defense in depth, not content sanitization.

No-key smoke: start server without `WEB_READER_BASE_URL` and invoke `read_web_page`; it must fail with `Web Reader is not configured.` without startup failure or outbound provider access. Standard deterministic tests require no key and make no live Reader call.

Optional live smoke reads only `https://example.com/` through the self-hosted Reader container. Ensure `WEB_READER_BASE_URL` resolves to a running `reader` container, then run:

```bash
npm run test:web-reader:live
```

Without a reachable Reader, the live command stops with a local base-URL-required test error before any provider access. Live provider access is optional and not required by CI.

## PM competitive analysis

PM Agent exposes `weekly-report-analysis` and `competitive-analysis` as user-invocable skills. Weekly analysis behavior and `pmr_...` links remain unchanged. Competitive prompts may use slash convention or natural language:

```text
/competitive-analysis GPT vs Claude vs Gemini
Compare Product X with similar incident-management platforms
Run competitive analysis for Product X in SMB accounting, focusing on automation
```

First named product is anchor. Later named products are mandatory seeds. PM Agent expands fewer than five competitors to five through seven and asks user to narrow more than seven supplied competitors. One run uses at most eight `search_web` calls (`maxResults: 10`, page 1), fourteen `read_web_page` calls, and one save. URLs come only from user input or search results. No crawler, recursive link following, QA-browser fallback, authenticated targets, PDFs, uploads, cookies, custom headers, signed URLs, alternate provider, new endpoint, or new credential exists.

PM Agent enforces the 8/14/1 caps at tool-execute time (`withCompetitiveResearchBudget`), so over-budget calls reject without provider access regardless of what the model requests. Failed `search_web` and `read_web_page` calls consume slots; a failed `save_competitive_analysis_to_garage` call does not consume the save slot (only a successful save counts), so a save can be retried after a validation or transient error. `Web Reader is not configured.` latches the run terminal, so further Reader calls reject immediately without provider access; availability, timeout, and page-specific failures may consume remaining slots. The model may still request a blocked tool, but the call is rejected locally and cheaply.

Complete report requires anchor plus five to seven competitors, each backed by one successfully read official/primary page. Search snippets are discovery-only. Reader Markdown is untrusted evidence and page-authored instructions must be ignored. Material claims use inline primary-source links. Feature cells use `Yes`, `Partial`, `No`, or `Unknown`; missing mention is `Unknown`, never `No`.

Completed Markdown sections are:

```text
# Competitive Analysis: <anchor product>
## Executive Summary
## Scope and Competitor Selection
## Product Profiles
## Feature Matrix
## Gaps and Opportunities
## Risks and Confidence
## Recommendations
## Sources
```

If minimum evidence cannot be met within budget, PM Agent returns `Incomplete Competitive Analysis: <anchor product>`, identifies missing evidence and suggested user action, and does not save or emit `Saved analysisId:`. Complete work saves once. Save failure does not discard completed analysis; response adds one short safe failure line.

Chat retrieval phrases should explicitly distinguish domains, for example `list saved competitive analyses` or `view pca_...`. Generic `list saved reports` remains weekly for compatibility. `pca_...` selects competitive detail; `pmr_...` selects weekly detail.

## Chat slash-command picker

Typing `/` as the first character of the chat input opens a keyboard-navigable picker listing the active agent's user-invocable skills. Arrow keys move the highlight, Enter or Tab inserts `/<skill-name> `, and Escape closes the picker without inserting. The picker filters skills by name as you continue typing after the slash (case-insensitive substring). Skills come from the active agent only: the client fetches the agent's serialized record through the same-origin `/api/agent/*` proxy and reads the `.skills` array, keeping only entries whose `user-invocable` flag is not `false`. Agents with no user-invocable skills show no rows and the picker stays closed. Inserting a skill does not send — finish the arguments and press Enter to dispatch through the normal message path, for example `/competitive-analysis gpt vs claude vs gemini`. The picker is client-only and adds no backend route.

Optional live smoke: configure existing SearXNG and Web Reader values without printing them, run one benign public competitive request, confirm six to eight evidenced products, inline citations, one source mapping per product, and successful save/list/view. Do not use compromised or pasted keys. Live providers are optional and CI never requires them. Competitive analysis introduces no environment variables.

## Storage

Mastra storage runs in the centralized Postgres container (`compose.yaml`, database `chekku_agent`). The default connection is:

```dotenv
DATABASE_URL=postgresql://chekku:postgres@localhost:5432/chekku_agent
```

`scripts/setup-env.sh` generates `POSTGRES_PASSWORD` into `storage/.env.local` (read by compose) and injects it into `DATABASE_URL` in `agent/.env.development`. The same Postgres instance hosts the `chekku_auth` database for Better Auth; the `scripts/postgres/init-databases.sh` init script creates it on first container init.

Before resetting data, stop the agent process. Reset local Postgres state by recreating its volume (this removes stored agents and conversation history):

```bash
docker compose down
docker volume rm chekku_postgres-data
```

The next `npm run dev:sh` recreates the container and re-runs the init script. The volume name is `<compose-project>_postgres-data` (project defaults to the repository directory name, `chekku`).

### Garage object storage

Local Garage runs image `dxflrs/garage:v2.3.0` with persistent Docker volumes and generic bucket `chekku-objects`. Compose publishes only the S3 API at `127.0.0.1:3900`; RPC, admin, and metrics ports stay inside the Docker network. Stop application processes before changing credentials. To stop local services without deleting their volumes:

```bash
docker compose --env-file storage/.env.local --env-file searxng/.env.local down
```

Do not commit or paste contents from `storage/.env.local`, `storage/.garage/`, `searxng/.env.local`, or generated `agent/.env.development`. Removing Garage volumes destroys local agent objects and is intentionally not part of normal reset instructions; removing SearXNG cache is also unnecessary for application reset.

Garage MCP validates relative keys before access, limits keys to 512 UTF-8 bytes, limits text to 262,144 UTF-8 bytes, and returns at most 100 list entries. Physical objects are isolated under `agents/<base64url-agent-id>/`; tool callers see relative keys only. Replace and delete run directly (no approval gate).

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

- `/reports` groups weekly and competitive report views.
- `/reports/weekly` lists weekly report ID, created time, risk rating, and status newest first.
- `/reports/[reportId]` renders saved analysis, metadata, then original weekly input.
- `GET /api/storage/pm-reports` returns `{ reports }` after server identity validation.
- `GET /api/storage/pm-reports/[reportId]` returns input, analysis, and metadata after identity and ID validation.

All four report interfaces call `client/src/server/pm-reports.ts` directly in the Next.js server and resolve the authenticated user from the Better Auth session cookie (server-side, via `getUserId()` / `requireUserId()`). They do not pass through Mastra. Chat PM tool calls separately pass through `/api/agent/*` and Mastra. Browser code never contacts Garage. Missing identity returns 403; invalid IDs return 400 or page not-found; missing reports return 404; storage failures return bounded 503 responses without provider details.

When PM Agent lists weekly reports in chat, its code-defined list tool generates a deterministic GFM table and agent returns it unchanged. Rows contain URL-encoded relative report links, compact UTC timestamps, ratings, and statuses. Links open in a new tab with `rel="noreferrer"`. Chat and `/reports/weekly` tables are labeled keyboard-focusable regions with visible focus styles and horizontal scrolling on narrow screens. Empty lists return `No saved reports found.` exactly; invalid stored timestamps remain visible rather than breaking the list.

PM report tools are not exposed by Garage MCP. Generic stored-agent Garage access remains exactly `create_text_object`, `get_text_object`, `list_text_objects`, `replace_text_object`, and `delete_object`. Garage v2.3 external-writer race limitations above apply to PM writes as well.

### Competitive analysis objects

Competitive tools and `client/src/server/competitive-analyses.ts` use same fixed `pm-agent` namespace but separate logical objects:

```text
competitive-analyses/<analysisId>/request.md
competitive-analyses/<analysisId>/analysis.md
competitive-analyses/<analysisId>/slides.md
competitive-analyses/<analysisId>/metadata.json
```

IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Metadata writes last, retains only canonical relative keys and bounded product data, and derives product/source counts. Save input requires five to seven unique competitors plus exactly one unique normalized public source URL for anchor and every competitor, plus a non-blank `slidesMarkdown` Marp deck produced by the same agent run. Presentation-only `analysisUrl` and `analysesMarkdown` never enter storage or view output.

Competitive interfaces:

- `/reports/competitive` lists analysis ID, created time, anchor, competitor count, and source count newest first.
- `/reports/competitive/[analysisId]` renders analysis, metadata, then original request.
- `/reports/competitive/[analysisId]/slides` renders the saved `slides.md` as a Marp deck through a client component.
- `GET /api/storage/competitive-analyses` returns `{ analyses }` after server identity validation.
- `GET /api/storage/competitive-analyses/[analysisId]` returns request, analysis, optional slides, and metadata after identity and ID validation.

Competitive chat lists return deterministic `analysesMarkdown` unchanged. Empty text is exactly `No saved competitive analyses found.` Lists and feature matrices use same accessible horizontal-scroll wrapper as weekly tables. Missing identity returns 403; invalid IDs return 400 or page not-found; missing analyses return 404; storage failures return fixed 503 messages without physical keys or provider details.

### Competitive analysis slides

Every completed `/competitive-analysis` run produces a `slides.md` Marp deck saved alongside the analysis. Open it at `/reports/competitive/<pca-id>/slides`. The deck renders client-side through `@marp-team/marp-core`; the route is server-rendered behind the same identity seam as the rest of `/reports/*`. The viewer exposes a Fullscreen toggle, a `N / M` slide counter that updates via IntersectionObserver, and a Print button that triggers browser print-to-PDF. No server-side rendering, no PPTX. Legacy analyses saved before this feature have no `slides.md` and the route returns 404 — re-run `/competitive-analysis` to produce one.

### Shareable slides

Each competitive analysis can be shared publicly via a token-gated link. From the detail page (`/reports/competitive/<pca-id>`), click `Create share link` to mint a 32-char hex token persisted as `share-token.json` alongside the analysis. The returned URL `/public/slides/<pca-id>?t=<token>` is unauthenticated and renders the deck through the same `CompetitiveSlides` component in public mode (no toolbar, no app chrome, footer with anchor product + created date).

The share token is the only credential gating public access; anyone with the URL can view the deck. Tokens are NOT rotated by repeated `Create share link` clicks (idempotent) and DO NOT expire (v1.1). Revocation is deferred to v2. All public-route failures collapse to 404 (missing analysis, wrong token, missing slides, storage outage) so observers cannot learn whether an analysis exists.

The public seam reads ONLY `share-token.json` and `slides.md` — never `analysis.md`, `request.md`, or `metadata.json`. Tokens are 128 bits of entropy (`crypto.randomBytes(16).toString('hex')`) and compared in constant time. Token-in-URL leakage via Referer headers, browser history, and server logs is acceptable for this use case (decks are non-sensitive competitive analysis); document and warn the user at share-create time.

## Browser operation

```dotenv
BROWSER_HEADLESS=true
```

Set it to `false` during local debugging when a visible browser is useful. The QA Web Agent keeps Memory enabled and runs browser actions directly (no approval gate).

Browser automation can fail when a site:

- blocks automated Chromium sessions;
- requires a user login or CAPTCHA;
- restricts network access;
- uses unsupported browser features.

Report the blocker rather than bypassing access controls.

## Android QA (qa-android-agent)

```dotenv
MAESTRO_ENABLED=false
MAESTRO_COMMAND=maestro
MAESTRO_WORKSPACE=../maestro
MAESTRO_ARTIFACT_DIR=../artifacts/maestro
MAESTRO_TIMEOUT_MS=120000
ADB_PATH=adb
```

Chekku, the Maestro CLI, ADB, and an Android emulator or physical device must be reachable on the same machine. Confirm with `adb devices` before enabling.

`MAESTRO_ENABLED` defaults to `false`; the server boots normally without Maestro installed. Set it to `true` only on a machine with Maestro, ADB, and a device.

Under the local dev server (`mastra dev`), the process cwd is `agent/src/mastra/public/` (not the agent workspace), and Mastra loads `agent/.env.development` rather than `agent/.env`. Put `MAESTRO_*` values in `agent/.env.development` for local dev, and use absolute paths for `MAESTRO_WORKSPACE` and `MAESTRO_ARTIFACT_DIR` (e.g. `MAESTRO_WORKSPACE=C:\dev\chekku\maestro`). The `../maestro` default is resolved relative to that `public/` cwd, so it would otherwise land flows and artifacts under `agent/src/maestro/` instead of the repo root.

The agent exposes an allowlisted subset of the built-in `maestro mcp` tools: `list_devices`, `inspect_screen`, `take_screenshot`, `cheat_sheet`, and `run`. `run_flow_files`, the cloud tools, and `open_maestro_viewer` are never attached. No tool requires approval — `maestro_run` (which executes flows, including inline/generated YAML) and the curated `run_maestro_flow` runner execute directly. There are no granular single-action tools — every device interaction (tap/input/back/launch) goes through `maestro_run` as inline YAML.

On Windows the Maestro command is typically a `.bat`/`.cmd`; the agent routes it through `cmd.exe /c` automatically (Node refuses to spawn `.bat` directly). If `MAESTRO_COMMAND` is on PATH as a plain executable, no wrapping is needed.

`run_maestro_flow` accepts logical names only (`{ suite: 'smoke', flow: 'login' }`), resolves them under `MAESTRO_WORKSPACE`, rejects traversal/absolute paths/backslashes, and writes JUnit reports and artifacts to `MAESTRO_ARTIFACT_DIR/<runId>/`. It never reports Passed unless Maestro exits 0.

The read-only `current_app` tool runs `adb shell dumpsys activity activities` (via `ADB_PATH`, default `adb`) and returns the foreground app's package name, so the agent can determine the `appId` itself instead of asking.

Common failures:

- **Maestro MCP reports missing tools / connection refused** — confirm `maestro mcp` starts manually and `MAESTRO_ENABLED=true` after restart.
- **No device** — the agent returns a Blocked result; start an emulator or connect a device and re-run.
- **Flow not found** — confirm the logical name maps to `<workspace>/<suite>/<flow>.yaml` and that the file is a regular file inside the workspace.

## Telegram channel (social-media-content-writer)

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

Get a key at [resend.com](https://resend.com). The default `onboarding@resend.dev` sender can only deliver to the account owner; production should use a Resend-verified domain in `RESEND_FROM_EMAIL`. Deliveries run directly (no approval gate). The tool fails with a clear error when `RESEND_API_KEY` is missing.

## Scheduled social drafts (weekly-social-drafts workflow)

```dotenv
SOCIAL_DRAFT_REVIEW_EMAIL=social-reviewer@example.com
# Optional but recommended — drives Stage 2 trending research:
SEARXNG_BASE_URL=http://localhost:8080
SEARXNG_API_KEY=
# Optional — movable feasts (Idul Fitri, Idul Adha, 1 Muharram, etc.).
# Defaults to the public api-hari-libur instance; unset to opt out.
PUBLIC_HOLIDAY_API_BASE_URL=https://api-hari-libur.vercel.app/api
#PUBLIC_HOLIDAY_CACHE_DIR=src/mastra/calendar/.cache
# Optional — enriches each chosen trending topic with the self-hosted Reader's
# page markdown. Unset = snippet-only (same as before Phase 2b).
WEB_READER_BASE_URL=http://127.0.0.1:8081
```

The `weekly-social-drafts` workflow fires every Monday at 09:00 Asia/Jakarta via Mastra's built-in scheduler (no separate registration). One run drafts 2 base Instagram captions plus, when the week contains a holiday, 1 bonus awareness post (total 2–3 drafts). Base slots come from SearXNG trending research; when `WEB_READER_BASE_URL` is set, each chosen topic is also enriched with the self-hosted Reader's page markdown (single-page read per topic, parallel, bounded — per-topic fetch failure falls back to snippet only). Remaining base slots are filled from the deterministic evergreen-pillar rotation when research yields fewer than 2 topics. Trending results that overlap the chosen awareness day are skipped so the bonus and a base slot do not duplicate the same theme. Each post is drafted through a two-step layered flow: Step 1 routes through the `social-media-supervisor-agent` (the `[weekly-social-drafts]` marker makes it delegate straight to the Content Writer, which runs in canonical mode) to emit a platform-agnostic Canonical Content Unit; Step 2 calls the `social-media-content-writer` directly (repurpose mode, `instagram-writer` voice) to derive the final Instagram caption. The canonical/repurpose mode is carried in `requestContext` (`SOCIAL_DRAFT_MODE_KEY`), not via an `instructions` override, so the supervisor's own routing instructions are never bypassed. Both outputs are wrapped into `post.md` under HTML comment delimiters, then saved to the fixed `social-media-agent` Garage namespace (the `SOCIAL_MEDIA_AGENT_ID` storage constant, decoupled from the agent identity) under `social-posts/<postId>/`. An unparseable canonical unit (empty or unstructured) is skipped before persistence and recorded in `researchNote`. The run then emails a review link per draft to `SOCIAL_DRAFT_REVIEW_EMAIL`.

`SOCIAL_DRAFT_REVIEW_EMAIL` must be set per environment — there is no default. When unset, the workflow still drafts and saves posts but skips the email step, recording `emailSent: false` and `emailError: 'SOCIAL_DRAFT_REVIEW_EMAIL is not set...'` in the run output. The workflow also needs `RESEND_API_KEY` for delivery and the five `GARAGE_*` values for persistence. Other email delivery failures are recorded in the run output (`emailSent: false`, `emailError`) without failing the run; saved drafts remain readable at `/social-posts` and `/social-posts/[postId]`.

`SEARXNG_BASE_URL` is optional. When unset (or when every research query fails), the workflow degrades to exactly 2 evergreen pillars with no awareness-day bonus and records a `researchNote` on the run output — research failure is never fatal.

`PUBLIC_HOLIDAY_API_BASE_URL` resolves movable feasts (Idul Fitri, Idul Adha, 1 Muharram / Tahun Baru Islam, Isra Mi'raj, Maulid Nabi, Nyepi, Paskah, Waisak, Natal) so the awareness-day bonus is no longer limited to the fixed-date `SPECIAL_DAYS` calendar. The API response is cached per year under `PUBLIC_HOLIDAY_CACHE_DIR` (default `agent/src/mastra/calendar/.cache/`, gitignored) so a single fire does not re-fetch 30+ years of data. When unset or unreachable, the workflow falls back to fixed-date entries only (Hari Kartini, Hari Guru Nasional, Hari Bumi, etc.) — observance days still produce a bonus, movable feasts do not.

Review interfaces:

- `/social-posts` lists post id, created time, topic, special day, and status newest first.
- `/social-posts/[postId]` renders caption, metadata, then the brief that generated it.
- `GET /api/storage/social-posts` and `GET /api/storage/social-posts/[postId]` return bounded JSON after server identity validation.

## Common failures

### Local service startup fails

Run from repository root with Docker responsive and both loopback ports free:

```bash
docker compose version
docker compose --env-file storage/.env.local --env-file searxng/.env.local ps garage searxng
```

`npm run dev:sh` reports whether Garage port `3900` or SearXNG port `8888` is occupied. Stop the conflicting process or container; do not edit the pinned Compose ports without a reviewed configuration change. If Compose configuration is invalid, remove no volumes: inspect tracked `compose.yaml`, `searxng/settings.yml`, and generated file permissions, then rerun the launcher.

### Local service readiness times out

Default readiness timeout is 30 seconds. First inspect health and logs without printing environment values:

```bash
docker compose --env-file storage/.env.local --env-file searxng/.env.local ps garage searxng
docker compose --env-file storage/.env.local --env-file searxng/.env.local logs garage searxng
```

For a slow Docker host, retry with `CHEKKU_READY_TIMEOUT_SECONDS` set from 1 to 300. `CHEKKU_READY_INTERVAL_SECONDS` must be a positive integer and is capped at 5. These launcher settings do not change `search_web`'s fixed 12-second request deadline.

### SearXNG search is not configured

For local operation, rerun `npm run dev:sh` so the launcher injects loopback configuration into Mastra. For external operation, confirm `SEARXNG_BASE_URL` reaches only the agent process and restart it. Do not add endpoint configuration to stored-agent payloads or browser environment.

### SearXNG search is unavailable or times out

For local operation, call `curl --fail http://127.0.0.1:8888/healthz` and inspect the SearXNG service status. For external operation, verify the base URL, reverse-proxy bearer authentication, JSON support, fixed `/config` and `/search` routes, and upstream search-engine latency from the Mastra host. Do not expose the optional bearer or copy raw upstream responses into tickets.

### Web Reader is not configured

For local development, ensure the `reader` Compose service is up (`docker compose ps reader`) and `WEB_READER_BASE_URL` resolves to it. `scripts/setup-env.sh` writes the canonical dev URL (`http://127.0.0.1:8081`) into `agent/.env.development`; in compose prod the service name resolves it (`http://reader:8081`). Restart the agent after changing env. Server should remain healthy while tool fails closed.

### Web Reader is unavailable or times out

Reader is a self-hosted container. Confirm `docker compose ps reader` shows it healthy and `WEB_READER_BASE_URL` points at the right host:port. Inspect container logs (`docker compose logs reader`) for outbound fetcher errors. Request deadline stays fixed at 30 seconds. Do not add configurable timeout, retries, anonymous fallback, or raw provider diagnostics.

### Garage MCP reports missing identity

`Agent identity is required.` means execution did not include trusted `context.agent.agentId`. Do not add an agent ID to tool input. Ensure the tool runs through a hydrated Mastra agent with the built-in `garage` MCP server.

### PM report is unavailable

Confirm report ID uses canonical `pmr_...` or `pca_...` format and all five `GARAGE_*` values reach both agent and Next.js server processes. PM Agent can save through agent process while report pages fail if client server lacks Garage configuration. Check `/reports/weekly` for weekly lists and `/reports/competitive` for competitive lists. Do not copy generated credentials into tracked files or bypass fixed `pm-agent` namespace.

### Competitive analysis is incomplete

This is not storage failure. Inspect named missing products/evidence and suggested action. Supply an official public product page, replace an agent-selected candidate, or change mandatory seed set, then rerun. Do not lower five-competitor minimum, treat search snippets as evidence, infer `No` from silence, or manually persist partial output.

An incomplete response must start with `# Incomplete Competitive Analysis: <anchor product>`, make claims only from successful current-run reads, omit save calls, and contain no `Saved analysisId:`. Unevidenced products may appear only as missing-evidence entries with safe failure context and suggested action.

### Garage object storage is not configured

Confirm all five `GARAGE_*` application values are available to the agent process. For local development, rerun `npm run dev:sh`; do not hand-copy generated credentials into tracked files.

### Garage is unavailable

Check Docker and local health without exposing environment values:

```bash
docker compose --env-file storage/.env.local --env-file searxng/.env.local ps garage
docker inspect --format '{{.State.Health.Status}}' "$(docker compose --env-file storage/.env.local --env-file searxng/.env.local ps -q garage)"
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

The test suite covers model routing, model discovery, prompt normalization, all five built-in agents, Telegram roles and slash commands, email delivery, weekly and competitive PM skills/tools/repositories, report APIs/pages and accessible tables, stored-agent payloads and fixed Garage/SearXNG/Web Reader hydration, bounded search and self-hosted reading transports with safe errors, stored-model migration, thread ownership, proxy paths, UI structure, namespaced storage, Garage adapter safety, Maestro flow runner, char-budget guard, and launcher behavior.

## Production run

`npm run prod` builds both workspaces and starts them together:

```bash
npm ci
npm run prod
```

This is equivalent to `npm run build && npm run start`. To run them separately (for staged deploys or build hosts):

```bash
npm run build
npm run start
```

`npm run start` runs `mastra start` (agent) and `next start` (client) side by side via `concurrently`. It does not provision local Docker services; production must reach Garage, SearXNG, and the model endpoint as external services or pre-provisioned infrastructure.

Environment differences from local development:

- `mastra start` loads `agent/.env` directly, not the generated `agent/.env.development` used by `mastra dev`. `npm run setup` (`scripts/setup-env.sh`) is an interactive local bootstrap: it prompts for `LLM_API_KEY` and the other runtime values and writes them straight into `agent/.env`. It is not a production secrets pipeline; provision production secrets through a deployment secret manager rather than an interactive local script.
- Under `mastra start`, the server process cwd is `agent/.mastra/output` (Mastra spawns the built bundle there), not the agent workspace. `MAESTRO_WORKSPACE` and `MAESTRO_ARTIFACT_DIR` resolve relative to that cwd, so the `../maestro` and `../artifacts/maestro` defaults would land under `agent/.maestro/` and `agent/.mastra/artifacts/`. Use absolute paths in production, as the `mastra dev` note above already requires.
- Server-only variables in `client/.env.local` are read at `next start` runtime, but `NEXT_PUBLIC_*` variables are inlined into the browser bundle at `next build` time, not at `next start`. `NEXT_PUBLIC_APP_URL` is consumed by `'use client'` code (`client/src/lib/mastra-client.ts`), so when build and start run on separate hosts the shipped bundle keeps the build-host origin and every `/api/agent/*` call targets the wrong place unless `NEXT_PUBLIC_APP_URL` is set to the production origin at build time.

See Production notes below for the durable `DATABASE_URL`, deployed origin, and secret-manager checklist.

## Containerized production

`npm run prod:sh` (or `bash scripts/prod.sh`) is the recommended way to run the full Chekku stack in containers. It activates the `prod` Compose profile so Garage, SearXNG, Postgres, the agent, and the client all run as containers; nothing application-level runs on the host.

```bash
npm run setup        # generates storage/.env.local, searxng/.env.local; prompts for LLM_* in agent/.env
npm run prod:sh      # build images, bring the stack up, wait for every service to be healthy
```

Subcommands:

- `npm run prod:sh` — build (if needed), bring everything up, wait for all five services to become healthy.
- `npm run prod:build` — build only the `agent` and `client` images.
- `npm run prod:up` — bring the stack up without rebuilding.
- `npm run prod:down` — stop and remove containers (named volumes are preserved).

The launcher parses the four dotenv files (`client/.env.local`, `agent/.env`, `searxng/.env.local`, `storage/.env.local`) with node+dotenv — never bash `source`, which cannot parse values containing spaces or special characters (`LLM_DISPLAY_NAME=Rafiqspace LLM`, `RESEND_FROM_EMAIL=Chekku <...>`) — and exports the merged values into its shell so Compose can interpolate every `${VAR}` it needs. It then fails closed if any required value (`POSTGRES_PASSWORD`, `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) is empty. Service-only secrets never reach the agent or client containers because their Compose `environment:` blocks do not declare them; `SEARXNG_SECRET` and `SEARXNG_CONFIG_HASH` legitimately reach the `searxng` container. The launcher never prints secret values.

In-container wiring is fixed by Compose and differs from local development:

- The agent binds `HOST=0.0.0.0`; its port `4111` is not published to the host. The client reaches it at `AGENT_URL=http://agent:4111` over the Compose default network.
- `DATABASE_URL` is constructed as `postgresql://chekku:${POSTGRES_PASSWORD}@postgres:5432/chekku_agent` (service name `postgres`, not `127.0.0.1`).
- SearXNG is reached at `http://searxng:8080` (the container's internal port), not the loopback `8888` used in development.
- Reader is reached at `http://reader:8081` (the container's HTTP/1.1 port), not the loopback `8081` host publish used in development.
- Every published port is loopback-only. The client publishes `127.0.0.1:3000`; put a reverse proxy (Caddy/nginx — a ready nginx template lives at [`ops/nginx/chekku.conf`](../ops/nginx/chekku.conf)) in front for TLS and public exposure. Garage, SearXNG, Reader, and Postgres also keep their development publishes, because `scripts/dev.sh` runs the agent and client as host processes against them and `scripts/db-migrate.sh` runs the Better Auth CLI on the host against `127.0.0.1:5432`.
- Each of those host ports is overridable for shared hosts where the default is already taken by another stack: `CHEKKU_CLIENT_HOST_PORT` (default 3000, set in `client/.env.local`), and `CHEKKU_GARAGE_HOST_PORT` / `CHEKKU_SEARXNG_HOST_PORT` / `CHEKKU_READER_HOST_PORT` / `CHEKKU_POSTGRES_HOST_PORT` (defaults 3900 / 8888 / 8081 / 5432, set in `agent/.env`). Leaving them empty keeps the defaults. They move the host side of the publish only — containers always reach each other at `garage:3900`, `searxng:8080`, `reader:8081`, `postgres:5432`, and `agent:4111`. `scripts/prod.sh` merges those files into its shell, so the overrides apply to the containerized stack; `scripts/dev.sh` reads `storage/.env.local` instead and is unaffected. Point the reverse proxy at whatever `CHEKKU_CLIENT_HOST_PORT` resolves to.
- Better Auth values reach the client container from `client/.env.local`: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `RATE_LIMIT_TRUST_PROXY`. `BETTER_AUTH_URL` must equal the public browser origin or session cookies and verification links break. Set `RATE_LIMIT_TRUST_PROXY=true` only when a reverse proxy supplies a trustworthy `x-forwarded-for`. `AUTH_DATABASE_URL` is **not** forwarded: Compose pins it to `postgresql://chekku:${POSTGRES_PASSWORD}@postgres:5432/chekku_auth`, leaving the `127.0.0.1` value in `client/.env.local` free for the host-side `npm run db:migrate`.
- The Compose project network is named `chekku-network` rather than the generated `chekku_default`, so it is identifiable on a host running several stacks.
- The QA Web Agent works in production because the agent image installs system Chromium and points the agent browser at it with `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`. Leave that variable empty outside the container: host development uses Playwright's own downloaded browser, and an empty value correctly falls back to it. The QA Android Agent (Maestro) stays host/device-only: `MAESTRO_ENABLED` is forced to `false` in the agent container.
- `NEXT_PUBLIC_APP_URL` is a **build-time** value for the client image. Next.js inlines `NEXT_PUBLIC_*` into the browser bundle during `next build`, so `scripts/prod.sh` forwards it from `client/.env.local` to the builder stage as a `build.args` entry. Before building for a real domain, set `NEXT_PUBLIC_APP_URL=https://studio.example.com` in `client/.env.local` and rebuild (`npm run prod:sh`); overriding it at runtime will not reach the already-built browser bundle. This mirrors the host-`prod` gotcha documented above.

Readiness timeout defaults to 60 seconds and is configurable via `CHEKKU_READY_TIMEOUT_SECONDS` (1–600). The launcher reports each service as it becomes healthy (`Garage ready`, `SearXNG ready`, `Postgres ready`, `Agent ready`, `Client ready`) and aborts with a bounded message if any service fails to become healthy.

### Containerized production troubleshooting

Direct `docker compose` invocations (for `ps`, `logs`, `exec`, etc.) need `SEARXNG_SECRET` and `SEARXNG_CONFIG_HASH`, which live in `searxng/.env.local` rather than `storage/.env.local`. Source both files into the shell once per session, then the `--env-file` flag is no longer needed:

```bash
set -a; source storage/.env.local; source searxng/.env.local; set +a
```

`npm run prod:sh` / `prod:up` / `prod:down` do not need this step — `scripts/prod.sh` parses every env file internally.

- **`Production Compose configuration is invalid`** — inspect `compose.yaml` and the local env files; rerun `npm run setup` if a file is missing.
- **`... is empty in ...`** — fill the named value in the named file (e.g. `LLM_API_KEY` in `agent/.env`) and rerun `npm run prod:sh`.
- **`Agent did not become healthy within ... seconds`** — inspect logs without printing secrets: `docker compose --profile prod logs agent` (after sourcing the env files as above). Confirm `HOST=0.0.0.0`, a reachable `DATABASE_URL`, and valid `LLM_*` values.
- **Client cannot reach the agent** — confirm the client container's `AGENT_URL=http://agent:4111` and that the agent container is healthy (`docker compose --profile prod ps`).
- **`next build` fails on `/_global-error` prerendering inside the container** — the builder stage must NOT set `NODE_ENV=development`; `next build` needs the default production `NODE_ENV`. `npm ci` installs devDependencies regardless of `NODE_ENV`, so the builder leaves it unset.
- **Reset production data** — same Postgres volume reset as development, but scoped to the prod profile:
  ```bash
  npm run prod:down
  docker volume rm chekku_postgres-data
  ```

## Reverse proxy

The client container publishes `127.0.0.1:3000` only (loopback, by design). Production puts a reverse proxy in front to terminate TLS and expose the studio publicly. A ready-to-copy nginx template with Let's Encrypt, WebSocket/SSE, and streaming support lives at [`ops/nginx/chekku.conf`](../ops/nginx/chekku.conf) with install steps in [`ops/nginx/README.md`](../ops/nginx/README.md).

When the proxy is in place, set in `client/.env.local` and rebuild the client image so the browser bundle picks up the new origin:

```dotenv
BETTER_AUTH_URL=https://studio.example.com
NEXT_PUBLIC_APP_URL=https://studio.example.com
RATE_LIMIT_TRUST_PROXY=true
```

`RATE_LIMIT_TRUST_PROXY=true` is safe to set only when the proxy **overwrites** `x-forwarded-for` with the real client IP. The shipped nginx template does this via `proxy_set_header X-Forwarded-For $remote_addr` — it must NOT use `$proxy_add_x_forwarded_for`, which appends and leaves the client-supplied leftmost entry in place (the app reads that entry, so appending would let a spoofer rotate rate-limit buckets). Behind a CDN that appends to XFF, the same overwrite must be enforced at the edge or the flag stays unset. Without a trusted proxy, leave it unset — the limiter then collapses every anonymous client onto one shared bucket per scope so a spoofed XFF cannot bypass the throttle. See the Authentication section above for the full rate-limit trust model.

## Production notes

Before deploying beyond local development:

- configure a deployment secret manager;
- set a durable Postgres `DATABASE_URL` and `POSTGRES_PASSWORD`;
- restrict `WEB_URL` to the deployed client origin;
- configure an authenticated server-to-server hop if the Mastra service is exposed separately;
- configure `SEARXNG_BASE_URL` and optional `SEARXNG_API_KEY` only in the agent service or deployment secret manager; keep the endpoint private or protect it with a reverse proxy;
- position the self-hosted `reader` container on the network the same way as the SearXNG service (egress filtering, DNS resolver, proxy). Chekku does not claim end-to-end SSRF or redirect enforcement inside the reader container; operators own that boundary;
- review browser and network policies;
- if the social-media-content-writer (Telegram) is enabled, set `TELEGRAM_MODE=webhook` with a public URL and `TELEGRAM_WEBHOOK_SECRET_TOKEN`, and provision a Resend-verified sender for the send-email tool;
- add rate limits, audit logging, and backup procedures appropriate to the environment.
