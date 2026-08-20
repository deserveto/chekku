# AGENTS.md

This file defines the operating rules for coding agents and contributors working in the Chekku repository. Follow it before changing source, tests, configuration, or documentation.

## Mission

Chekku is a local-first agent studio built from three npm workspaces:

- `agent/`: Mastra server, code-defined agents, stored-agent runtime, Memory, Postgres, browser automation, tools, and model gateway.
- `client/`: Next.js interface, same-origin proxy, agent catalog and builder, chat UI, thread history, and server-side identity seam.
- `storage/`: shared generic object-storage contract, agent namespace helpers, Garage/S3 adapter, and PM report repository.

The repository intentionally contains only the current working architecture. Do not restore retired parallel runtimes from old reconstruction archives.

## Source of truth

Read these first:

1. `agent/src/mastra/index.ts` — backend composition root.
2. `client/src/app/api/agent/[...path]/route.ts` — browser-to-Mastra proxy boundary.
3. `client/src/lib/stored-agents.ts` — stored-agent client operations.
4. `client/src/lib/memory-threads.ts` — thread listing, reading, renaming, deletion, and ownership checks.
5. `storage/src/index.ts` — shared generic object-storage and PM report APIs.
6. `client/src/server/pm-reports.ts` and `client/src/server/competitive-analyses.ts` — authenticated server-only PM report boundaries.
7. `agent/src/mastra/mcp/garage-mcp-server.ts` — built-in generic Garage MCP capability.
8. `agent/src/mastra/mcp/searxng-mcp-server.ts` — built-in fixed SearXNG MCP capability.
9. `agent/src/mastra/searxng/client.ts` — bounded SearXNG transport and output normalization.
10. `agent/src/mastra/mcp/web-reader-mcp-server.ts` — built-in fixed Web Reader MCP capability.
11. `agent/src/mastra/web-reader/client.ts` — bounded self-hosted Reader transport and output normalization.
12. `agent/src/mastra/gateways/openai-compatible.ts` — final model transport.
13. `docs/ARCHITECTURE.md` — runtime structure and data flow.
14. `docs/OPERATIONS.md` — environment and troubleshooting.

## Required commands

Run from the repository root:

```bash
npm ci
npm run check
npm run build
```

During iteration, use narrower commands when helpful:

```bash
npm run typecheck --workspace agent
npm run typecheck --workspace client
npm run lint --workspace client
npx vitest run path/to/file.test.ts
```

A task is not complete until affected tests pass. Before finalizing any repository-level change, run the full `npm run check` and `npm run build` commands.

Toolchain facts:

- Node `>=22.22.0` is pinned in `.nvmrc` and in the `engines` fields of the root and `agent` package manifests (`client` and `storage` declare no `engines`). CI runs `npm run check` and `npm run build` with `NODE_OPTIONS=--max-old-space-size=8192`; typecheck and build can exhaust the default heap.
- Run `npm ci` from the root after every pull. Stale workspace symlinks make Mastra fail with `Invalid Version: ^1.14.0`-style errors.
- `npm run check` order is typecheck (`@chekku/storage` then `agent` then `client`) → lint → test. `npm run lint` covers the `client` workspace only.
- Root `package.json` `overrides` pin `@mastra/core`, `@mastra/pg`, and `zod` for all workspaces.
- `npm run dev:sh` provisions the local Garage, SearXNG, Reader, and Postgres containers before starting both workspaces; plain `npm run dev` starts only the workspaces and assumes services are up.
- `npm run db:migrate` applies the Better Auth schema to `chekku_auth`; it needs Postgres running and is safe to re-run.
- `agent` scripts map to the Mastra CLI (`mastra dev` / `mastra build` / `mastra start`); `mastra build` installs generated-bundle dependencies and needs npm registry access.

## Architecture invariants

### One Mastra runtime

- Keep `agent/src/mastra/index.ts` as the single server composition root.
- Custom server routes are `/healthz`, `/models`, and the server-owned agent-run surface (`/runs`, `/runs/active`, `/runs/list`, `/runs/:runId`, `/runs/:runId/events`, `/runs/:runId/cancel`). Do not add other custom routes unless a new requirement cannot use Mastra's native APIs.
- Do not recreate custom `/api/conversations`, `/api/chat`, `/api/builder`, or raw-SQL agent routes.

### Agent run lifecycle

- Execution is server-owned. A run is created through `POST /api/runs`, executed by `agent/src/mastra/runs/execute.ts` with a server-owned `AbortController`, and tracked in the in-memory registry `agent/src/mastra/runs/run-registry.ts`. The lifetime of a run must not be the lifetime of an HTTP connection, a browser tab, or a ChatStudio React component.
- One non-terminal run per `(agentId, threadId, resourceId)` is enforced server-side; duplicates receive 409 with the active run so the client attaches instead of duplicating. Never enforce run uniqueness with client state (`isStreaming`, disabled buttons, refs, or mounted components).
- Concurrent running runs are capped (registry constants: 4 per `resourceId`, 64 across the server, enforced in `createRun` after the 409 conflict check). Exceeding a cap surfaces from `POST /runs` as HTTP 429 with a fixed bounded message. A watchdog force-fails running runs older than 30 minutes (fixed message, aborts the execution signal, releases the thread's 409 lock) so a hung gateway stream cannot lock a thread until restart.
- Run event buffers are bounded (4 MiB / 10 000 events per run, oldest-eviction with an `evicted` flag) and terminal runs are retained 30 minutes for replay. The registry is in-memory and single-instance: an agent server restart kills runs and registry together. Never add durable run storage that would outlive the execution it describes.
- Starting and observing a run are distinct operations. The run client (`client/src/lib/agent-runs.ts`, consumed by ChatStudio) discovers a thread's active run on mount and subscribes with offset-based replay (exactly-once across reconnects); it must never restart the prompt when reconnecting.
- The Next.js `/api/runs/*` seam (`client/src/app/api/runs/[[...path]]/route.ts`) derives `resourceId` from the Better Auth session on every request, discards any client-supplied value, and validates thread ownership before forwarding. It forwards the client's multimodal `content` on run starts as an array-only passthrough; full part and bound validation belongs to the agent server's `parseStartRunRequest`. Agent-side run routes mirror the thread-ownership check (`agent/src/mastra/runs/thread-ownership.ts`) and collapse foreign run IDs to 404.
- Stop cancels by run ID (`POST /api/runs/:runId/cancel`, idempotent). Do not reintroduce thread-scoped `abortThread` cancellation for the chat UI.
- First-turn thread titles are set server-side when the run starts (`ensureFirstTurnThread` in `agent/src/mastra/runs/execute.ts` creates the Memory thread record with the 52-character prompt truncation before the 202 response is sent), so a new thread is named and listed the moment the prompt is sent. Mastra persists the user message only at turn end; the browser never owns renaming and never needs to wait for completion to see the thread or its title.
- Run summaries carry the starting `prompt`. Because the user message is not in Memory while the turn is in flight, a client attaching to a running run (mount discovery or a 409 duplicate) synthesizes the user turn plus an empty assistant placeholder from the run record, so replayed tool and text events render immediately instead of the empty welcome state. ChatStudio refreshes the thread list as soon as `startRun` succeeds.
- Native alternatives were evaluated and rejected: Mastra `observe` replay requires `mastra.pubsub` or `DurableAgent`/Redis, which Chekku does not run, and the `sendMessage`/`subscribeToThread`/signals surface is `@experimental`. The run manager uses only stable primitives (`agent.stream` with caller-supplied `runId` and `abortSignal`, `mastra.getAgentById`). `getAgentById` resolves by the agent's public id first and falls back to a registry-key lookup, so stored agents registered at runtime resolve through the run surface too; prefer it over `getAgent` because the public id is what clients send and composition keys (`mainAgent`, ...) are internal.

### Stored agents

- Use `@mastra/editor` for stored-agent creation, versioning, persistence, and hydration.
- Use `client/src/lib/stored-agents.ts` and the Mastra client instead of direct database access.
- Code-defined agents are protected and must not be edited or deleted through stored-agent APIs.
- Preserve stored-agent model migration through `client/src/lib/stored-agent-migration.ts`.
- Stored agents may reference registered tools and delegate agents by ID; do not persist API keys in agent records.

### Storage and conversations

- `PostgresStore` (`@mastra/pg`) is the sole Mastra storage implementation. It connects via `DATABASE_URL` to the centralized Postgres instance in `compose.yaml` (database `chekku_agent`); the same instance hosts `chekku_auth` for Better Auth. `@chekku/storage` (Garage/S3) remains the separate object-storage boundary and is not a relational store.
- Generic Garage object access belongs in `storage/`, not agent-private or browser modules.
- `ObjectStorage` exposes text operations as required members and binary operations (`createBytes`, `replaceBytes`, `getBytes`) as optional interface members; production Garage, lazy, and namespaced adapters implement all three. Use `asBinaryObjectStorage` to narrow a store to binary capability at consumption sites. Binary reads are bounded to 16 MiB and reuse the same error-sanitization path as text operations.
- Garage MCP and server-side code share `@chekku/storage`; browser components must never import it or access Garage directly.
- PM report persistence composes the generic contract in `storage/src/pm-reports.ts`; it must not add PM semantics to Garage MCP.
- Garage application configuration uses only `GARAGE_ENDPOINT`, `GARAGE_REGION`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY_ID`, and `GARAGE_SECRET_ACCESS_KEY`.
- Generated `storage/.env.local`, `storage/.garage/`, `searxng/.env.local`, and `agent/.env.development` stay ignored. Never expose their secrets in logs, errors, or commits; documentation may identify internal service state by variable name only.
- Conversation history uses Mastra Memory, not custom conversation tables.
- Every agent must bound its context to prevent overflow using all three helpers from `agent/src/mastra/processors/context-limit.ts`: `createAgentMemory()` (sets `lastMessages`), `createAgentContextLimiter()` (a `TokenLimiterProcessor`) in `inputProcessors`, and `createCharBudgetGuard()` (a `processLLMRequest` backstop) wired LAST in `inputProcessors` (after the gateway compatibility processor where present). Never use bare `new Memory()` — tokenx (the `TokenLimiterProcessor` estimator) under-counts dense tool output, notably base64 screenshots (empirically ~1.67× drift vs real BPE), so heavy multi-step turns can exceed the real model window even when the estimate says they fit; the char-budget guard is what actually prevents overflow within a single multi-step turn.
- A thread ID must use this format:

```text
{agentId}-{resourceId}-{uuid}
```

- Every list, read, rename, and delete operation must verify agent and resource ownership.
- Never show one agent's threads in another agent's history.

### Models and secrets

- Runtime model configuration uses only:

```text
LLM_BASE_URL
LLM_API_KEY
LLM_DEFAULT_MODEL
LLM_DISPLAY_NAME
LLM_MODELS
# image generation only (reuses LLM_BASE_URL + LLM_API_KEY; no second key)
LLM_IMAGE_MODEL
LLM_IMAGE_ENDPOINT_PATH
```

`LLM_IMAGE_MODEL` and `LLM_IMAGE_ENDPOINT_PATH` are server-only, scoped to the Visual Content Agent's `generate_image` tool; `LLM_IMAGE_MODEL` is empty by default and the tool fails closed when unset (never a silent live call to an unconfigured model).

- The API key stays server-side in `agent/.env` or a deployment secret manager.
- Never introduce provider-specific runtime variables or browser-exposed keys.
- Model IDs stored by the editor use the custom gateway prefix internally. Endpoint-native model IDs remain intact after the prefix is removed.
- `getServerModel()` is the common model resolver for code-defined agents.
- `/models` must expose the canonical default and available model list without exposing credentials.

### Hosted-vLLM compatibility

- Keep `normalizeSystemMessages()` at the final model boundary.
- Apply it to both `doGenerate` and `doStream`.
- Merge all system messages at the beginning while preserving the order of user, assistant, and tool messages.
- Never sort messages by role.

### QA Web Agent

- `qa-web-agent` must keep `memory: createAgentMemory()` with `createAgentContextLimiter()` and `createCharBudgetGuard()` wired into `inputProcessors` (guard last, after the gateway compatibility processor), because browser context processing requires active Memory context.
- Keep the gateway compatibility processor unless tests prove it is no longer needed.
- No tool requires approval; browser actions (form submit, purchase, publish, delete) run directly.
- Do not add endpoint-specific discovery tools to the QA agent. Model discovery belongs in the gateway and `/models` route.

### QA Android Agent

- Keep `qa-android-agent` code-defined with Mastra Memory and the gateway compatibility processor.
- Bind a trusted, env-gated `MCPClient` to `maestro mcp` privately on this agent only. Maestro stays outside the fixed global `garage`, `searxng`, and `web-reader` MCP servers.
- Expose only the explicit Maestro tool allowlist (`list_devices`, `inspect_screen`, `take_screenshot`, `cheat_sheet`, `run`); never expose `run_flow_files`, cloud tools, or `open_maestro_viewer`. Never auto-attach every tool from `listTools()`.
- No tool requires approval; `maestro_run` (flow execution, incl. inline/generated YAML) and the curated `run_maestro_flow` run directly. There are no granular single-action tools.
- A read-only `current_app` tool (adb-backed via `ADB_PATH`) returns the foreground app's package so the agent can self-serve the `appId` instead of asking; it never mutates the device.
- On Windows, route the Maestro `.bat`/`.cmd` command through `cmd.exe /c` (Node blocks direct `.bat` spawn since CVE-2024-27980).
- The curated flow runner accepts logical `{ suite, flow }` names only; reject absolute paths, `..`, backslashes, caller-supplied extensions, and non-regular files; resolve real-path containment after symlinks.
- Run flows via `execFile` with an argv array (never a shell string), `--format junit --output` and `--test-output-dir` into `artifacts/maestro/<runId>/`, with `MAESTRO_TIMEOUT_MS`, bounded output, and child cleanup.
- Never report a test Passed unless Maestro exited 0.
- `MAESTRO_ENABLED` defaults to `false`; the server boots normally without Maestro.
- A failed Maestro MCP load (bad command, crashed subprocess, timeout, protocol error) is logged once with a `[qa-android-agent]` prefix and cached as empty for the lifetime of the server process; an operator must restart the agent server to retry.

### Social Media Content Writer

- Keep `social-media-content-writer` code-defined with Mastra Memory, Telegram channel integration, role switching, and the `send-email` tool.
- It is the drafting sub-agent under the Social Media Supervisor (attached via the supervisor's `agents` field). The Telegram channel and `/help`, `/roles`, `/role`, `/switch` slash commands stay on this agent; the supervisor has no tools and only routes.
- The Content Writer has two output modes (per PROMPT.md action item #3 + locked D2=c):
  - **Chat mode (default)** — `buildInstructions(role)` produces role-specific ready-to-post captions per the active role (general / x-writer / instagram-writer / linkedin-writer / tiktok-writer). Used by Telegram chat.
  - **Canonical mode** — `buildCanonicalInstructions()` produces a Canonical Content Unit (8 Blocks platform-agnostic intermediate). Used by the scheduled workflow's Step 1.
  - **Repurpose mode** — `buildRepurposeInstructions(role)` rewrites a canonical unit into a platform caption in the active role's voice. Used by the scheduled workflow's Step 2.
- The `instagram-writer` role carries the brand identity ("R — Your Gentle AI Companion", tagline "AI Human-Centered Intelligence", sign-off "Hormat kami, Keluarga Besar PT Rafiq Space Intelligence"), the reflective/warm/professional tone guardrail, and the quote policy (well-known religious/cultural verses with attribution OK; statistics and unverifiable claims still require `[source]` placeholder). Do not move brand identity into env vars or the workflow prompt — the role is the single source of truth so Telegram chat output and the repurpose step stay consistent.
- Preserve `/help`, `/roles`, `/role`, and `/switch` registration after `AgentChannels` initialization.
- Telegram uses `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MODE`, optional `TELEGRAM_BOT_USERNAME`, and optional `TELEGRAM_WEBHOOK_SECRET_TOKEN` only.
- Email uses server-only `RESEND_API_KEY` and `RESEND_FROM_EMAIL`; never expose either to browser code.
- Outbound email and channel actions run directly (no approval gate).
- The scheduled `weekly-social-drafts` workflow drafts through the Social Media Supervisor (per locked D3=a "full supervisor routing"), NOT through `socialMediaContentWriter.generate(...)` directly. The workflow calls `socialMediaSupervisorAgent.generate(...)` with the canonical-mode instructions (`buildCanonicalInstructions`); the supervisor sees the `[weekly-social-drafts]` system marker in the canonical prompt (`buildCanonicalPrompt`) and delegates straight to the Content Writer without a reasoning turn. The repurpose step then calls `socialMediaContentWriter.generate(...)` directly with repurpose instructions (`buildRepurposeInstructions`) and a format-specific prompt — no supervisor routing is needed for repurpose because the target sub-agent is already known.
- Two-step layered drafting (per locked D2=c): Step 1 emits a Canonical Content Unit (platform-agnostic intermediate, 8 Blocks: `[TOPIC]`, `[THESIS]`, `HOOKS` with all three Curiosity/Contrarian/Data-Impact angles, `CORE POINTS`, `SHORT-FORM BRICK`, `MEDIUM-FORM BRICK`, `IMAGE BRICK`, `CALL TO ACTION / ENGAGEMENT`). The `IMAGE BRICK` is a designed 1:1 poster/infographic composition (NOT a bare photograph, NOT a video script) whose panels carry actual text drawn from the canonical content; the parser still reads the legacy `VISUAL / VIDEO SCRIPT BRICK` header for backward compatibility with older `post.md` files. Step 2 repurposes the canonical unit into a final platform caption via `buildRepurposePrompt`. The canonical unit is the source of truth; the AGENTS.md format split lives in the repurpose layer, not in canonical generation.
- The workflow's `buildRepurposePrompt` dispatches the caption format by topic kind. **Awareness days and evergreen pillars** use the structured greeting-card copy (header → "Selamat {day}" title → date line → opening → optional verse → "Poin-poin" brand-value bullets with `**[Value]:**` format → tagline → sign-off) — unchanged. **Trending topics** use a Folkative-style news caption (10-15 word visual headline for the image + 1-2 paragraph casual conversational caption + subtle CTA + emoji at end) with NO brand stamps, NO "Poin-poin" bullets, NO "Hormat kami" sign-off. Indonesian-first. The format split is intentional: awareness-day content suits the formal brand greeting-card voice; trending news needs the casual news-magazine voice to land with the audience.
- `post.md` storage layout (per locked D4=a, no schema change): the file stores BOTH the canonical unit and the repurposed caption, wrapped via `wrapPostMarkdown` from `agent/src/mastra/social-content/canonical-unit.ts` using HTML comment delimiters (`<!-- canonical-unit -->…<!-- /canonical-unit -->` and `<!-- repurposed-caption -->…<!-- /repurposed-caption -->`). Legacy posts written before the canonical contract have no delimiters and fall back gracefully — `unwrapPostMarkdown` returns the whole file as canonical. The `SocialPostMetadata` schema itself does not change; the canonical unit is just markdown text.
- Trending research filters results through two host checks: `BLOCKED_HOST_PATTERNS` drops social-media domains (TikTok/Instagram/YouTube/Facebook/etc.); `CREDIBLE_HOST_PATTERNS` requires recognized Indonesian + international news sources (Kompas, Detik, Tempo, CNN Indonesia, BBC, Reuters, AP, etc.). A homepage/category filter further rejects `bbc.com/`, `bbc.com/indonesia`, requiring article paths with 2+ segments so the topic is a specific article, not an aggregator index.

### Social Media Supervisor

- Keep `social-media-supervisor-agent` code-defined with Mastra Memory and the context-safety processors (`createAgentMemory()`, `createAgentContextLimiter()`, and `createCharBudgetGuard()` wired LAST in `inputProcessors`).
- The supervisor has no tools. It routes incoming requests to its sub-agents via Mastra's `agents` field and `network()` loop; it must not draft, repurpose, plan, or generate visuals itself. It carries an explicit `defaultOptions: { maxSteps: 15 }` bound and instructions to complete the full request in a single user turn: when one message needs several sub-agents (e.g. research → draft), it delegates to each in sequence within the same turn and only returns once the whole request is resolved — it must never stop after one delegation to ask whether to continue.
- Conversational visual approval (native chat, no custom button): the draft→visual boundary is the one deliberate exception to the autonomous single-turn rule. When a single request combines drafting content AND generating a visual, the supervisor delegates the drafting (and any research) to completion, presents the draft, PROPOSES A CONCRETE VISUAL CONCEPT for the image (subject/setting/style/mood derived from the content), then asks the user conversationally to confirm or adjust that concept and ENDS its turn there. It must never invent the visual silently — the user must always see and approve the concrete concept before generation. It must not delegate to the Visual Content Agent until the user replies with an explicit approval (ya / lanjut / approve / ok / dst.); a caption revision goes to the Content Writer and a visual-concept change updates the proposal, then it asks again. A standalone visual request with no preceding draft goes straight to the Visual Content Agent with no checkpoint. This implements the agreed review-before-image flow without any custom UI.
- Attach the Content Writer, the Strategist, and the Visual Content Agent as sub-agents (`agents: { socialMediaContentWriter, socialMediaStrategistAgent, visualContentAgent }`). Future sub-agents attach here, not on the Content Writer.
- Drafting/rewriting/repurposing/caption/platform-formatting requests route to the Content Writer; strategy/brief/content-plan/audience-research requests route to the Strategist; image/illustration/visual-asset/thumbnail/artwork requests route to the Visual Content Agent. Visual generation happens only after an explicit user request — the supervisor must not auto-dispatch the Visual Content Agent when the Content Writer finishes. Forward the `postId` unchanged; never fabricate approval status (the Visual Content Agent and its tool verify it from persisted metadata).
- Active call paths opt into routing by invoking the supervisor; the Telegram channel and slash commands stay on the Content Writer for now, so the supervisor is exercised through the chat UI, the scheduled `weekly-social-drafts` workflow, or future integrations.
- Scheduled workflow fast-path: when the supervisor sees the `[weekly-social-drafts]` system marker in the prompt, it delegates straight to Content Writer without reasoning. This keeps the supervisor as the single routing seam for the social-media surface without paying an extra reasoning turn for a deterministic call path.

### Visual Content Agent

- Keep `visual-content-agent` code-defined with Mastra Memory, the gateway compatibility processor, and the context-safety processors (`createAgentMemory()`, `createAgentContextLimiter()`, `gatewayCompatibilityProcessor`, and `createCharBudgetGuard()` wired LAST in `inputProcessors`, after the gateway compatibility processor).
- Orchestration uses the normal server language model (`getServerModel()`), NOT the image model. The fixed image model (`LLM_IMAGE_MODEL`, e.g. `gemini-3.1-flash-image`; empty/unset fails closed with a fixed configuration error) is invoked only inside `generateImageTool` (output) and `reviewImageTool` (multimodal vision input).
- Bind exactly `tools: { generateImageTool, reviewImageTool }` in production, plus `previewImageTool` dev-only. Do not attach generic Garage MCP tools, Telegram channels, or slash commands. The agent has no channels.
- `defaultOptions: { maxSteps: 9 }` — sized to absorb the worst-case self-review loop (generate → review → regen → review → regen → review → final reply = 7 steps) plus reasoning headroom.
- Image generation is on-demand only: it never runs automatically after the Content Writer finishes or inside the `weekly-social-drafts` workflow. It only runs when the user explicitly asks the supervisor for a visual and the supervisor delegates.
- The `generate_image` tool verifies the post's persisted status is exactly `APPROVED` before any provider call; it rejects `DRAFT` (and `PUBLISHED` for this iteration). It loads the post via `getSocialPost`, calls the image-generation client, stores bytes via the binary storage capability, and attaches the asset to canonical metadata (metadata written last). The model never chooses the model id, endpoint, namespace, object key, or approval status.
- **Regeneration cap (Pembahasan 1):** `MAX_VISUAL_ASSETS_PER_POST = 3` (exported from `agent/src/mastra/tools/generate-image.ts`). The tool counts `metadata.visualAssets.length` BEFORE any provider call; once a post already has three assets the next call rejects with the fixed `SAFE_ERRORS.maxRegenerationsReached` message and the agent must stop and return the latest image. The cap check runs AFTER the approval gate so a `DRAFT` post still reports not-approved first. This caps the self-review loop at one initial generation plus two retries.
- **Self-review loop (Pembahasan 1):** after every successful `generate_image`, the agent MUST call `review_image` on the freshly attached `assetId` before deciding whether to return. `review_image` is the same fixed image model invoked through `/chat/completions` with an `image_url` content part (`agent/src/image-generation/review-client.ts`); it returns `{ postId, assetId, score, issues, suggestion, model, reviewedAt }` and the agent treats `score >= 85` as pass. On pass the agent returns the result; on fail it appends `suggestion` to the prompt and calls `generate_image` again, repeating until pass or until the cap rejects. The loop runs ONLY for post-bound `generate_image` calls — never for dev-only `preview_image` (no `postId`, no `assetId`, no brief).
- `review_image` is read-only, non-destructive, idempotent, open-world (`mcp.annotations`). It verifies the `assetId` actually belongs to the `postId` via `getSocialPost` before any provider call, then reads bytes via `readVisualAssetBytes`. It never mutates the image, the post, or the persisted asset. Review is advisory: a `review-failed` provider error or an unparseable verdict resolves to `pass` (score 100) so the loop never blocks on a flaky reviewer.
- The image-generation provider boundary lives in `agent/src/image-generation/`. It uses only the existing `LLM_BASE_URL` and `LLM_API_KEY`; no second key. The fixed model comes from `LLM_IMAGE_MODEL`; the generation endpoint path from `LLM_IMAGE_ENDPOINT_PATH` (default `/images/generations`), the review endpoint is fixed to `${LLM_BASE_URL}/chat/completions` (not configurable — the OpenAI chat-completions contract is the only multimodal path). The concrete HTTP adapters target the OpenAI Images API (generation) and OpenAI Chat Completions API (review) standard contracts; if the live gateway differs, only `agent/src/image-generation/client.ts` (generation) or `agent/src/image-generation/review-client.ts` (review) needs adjustment. All lower layers are verified through dependency-injected test doubles.
- **Visual pipeline split (Rafiqspace upgrade):** the image-generation gateway contributes ONLY the background visual; typography and the brand logo are owned by the application compositor. The flow is: Visual Content Agent assembles a structured `VisualBrief` (`agent/src/image-generation/visual-brief.ts`) with two halves — `imagePrompt` (pure-visual, NO text/typography/logo requests) and `textLayers` (headline + 2–3 verified facts + optional editorial context + source attribution). The tool pipeline calls the image model with `imagePrompt` only, then `composeVisual` (`agent/src/image-generation/compositor.ts`, backed by `@napi-rs/canvas`) overlays the headline, facts, source, and the real Rafiqspace logo PNG from `agent/src/assets/image.png`. The image model NEVER renders text, headlines, numbers, logos, or watermarks — those requests are appended as negative instructions when helpful.
- **Brand asset (`agent/src/assets/image.png`):** the SINGLE canonical Rafiqspace logo. The compositor loads it via `loadBrandLogoBytes()` and stamps it onto every generated visual as-is — never regenerated, never redrawn, never substituted with wordmark text. Resolution: `resolveBrandLogoPath()` walks up from `process.cwd()`, probing `src/assets/image.png` and `agent/src/assets/image.png` at each level (covers repo-root CWD, agent-workspace CWD, and deep `mastra dev` CWDs); the production container ships the asset via the Dockerfile runtime `COPY agent/src/assets`. Tests inject a fixture logo via the `logoPath` option on `createPreviewImageTool` / `createGenerateImageTool`.
- **Pillar-aware composition plans:** `COMPOSITION_PLANS` (in `visual-brief.ts`) defines palette + zones per pillar — TECHNOLOGY (deep navy + cyan accent + bottom-right logo), CELEBRATION (light + gold accent + top-left logo), GENERAL (brand blue + bottom-right logo). The compositor draws a header zone (logo + headline + optional context), a middle zone (cover-fit of the generated background), and a footer zone (2–3 facts in columns + source line). Layout is deterministic given (brief, backgroundBytes, logoBytes).
- Revisions regenerate: a new `sva_` asset id and object key are produced and the previous asset is preserved in `visualAssets`; there is no editing, inpainting, image-to-image, mask editing, or image upload.
- Visual assets live under the historical `social-media-agent` namespace at `social-posts/<postId>/visuals/<assetId>.<ext>`, served by `GET /api/storage/social-posts/<postId>/visuals/[assetId]`. Metadata never contains base64 image data or Garage credentials.
- The `generate_image` and `review_image` tools are registered only on `visual-content-agent`. They must not enter `storedAgentTools`, `garageMcpServer`, `searxngMcpServer`, `webReaderMcpServer`, or any stored-agent registry.
- Dev-only chat preview: outside production (`NODE_ENV !== 'production'`), `visual-content-agent` also registers `preview_image` (`agent/src/mastra/tools/preview-image.ts`). It accepts the SAME `VisualBrief` contract as `generate_image`, composes a final PNG via the same compositor (background + text layers + real logo), stores bytes under an ISOLATED `chat-previews/<previewId>.png` prefix in the `social-media-agent` namespace (a different prefix from `social-posts/`, so `/social-posts` never lists these), and returns a URL (never base64, to keep the agent's context budget healthy across multi-turn chats). It performs no post/approval check and never touches `social-posts/` or post metadata. The Visual Content Agent uses `preview_image` for ad-hoc chat visuals with no `postId`, and `generate_image` only when a request names an approved `postId`. `preview_image` is NOT part of the self-review loop — never call `review_image` on a `previewId`. Previews are served by the dev-only `GET /api/storage/chat-previews/[file]` route (identity-checked, 404 in production). In production only `generate_image` + `review_image` are registered. `preview_image` must not enter any stored-agent or MCP registry either.

### Client proxy and identity

- Browser-to-Mastra agent-service requests target the Next.js origin and pass through `/api/agent/*`. The server-owned agent-run surface passes through `/api/runs/*` (`client/src/app/api/runs/[[...path]]/route.ts`), which injects the session-derived `resourceId` and validates thread ownership before forwarding. PM report pages stay under `/reports/*`; weekly and competitive APIs stay under `/api/storage/pm-reports/*` and `/api/storage/competitive-analyses/*` in the Next.js server. Social post pages stay under `/social-posts/*`, and social post storage APIs stay under `/api/storage/social-posts/*`.
- The `/api/agent/*` proxy must continue supporting `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`. (The `/api/runs/*` seam intentionally supports only `GET` and `POST`.)
- Validate upstream paths with `client/src/server/proxy-url.ts`.
- `CHEKKU_LOCAL_USER_ID` has been replaced by Better Auth email/password. `getUserId()` / `requireUserId()` in `client/src/server/auth.ts` resolve the authenticated user from the Better Auth session cookie; `resourceId` (Memory thread ownership) equals `session.user.id`. Thread-ownership semantics are unchanged from the `CHEKKU_LOCAL_USER_ID` era.
- Better Auth lives in the `client` workspace only. The required client env vars are `BETTER_AUTH_SECRET` (32+ random chars), `BETTER_AUTH_URL` (Next.js origin), and `AUTH_DATABASE_URL` (points at the `chekku_auth` database on the shared Postgres instance). All three stay server-side and never enter the client bundle. The agent server is untouched and never imports Better Auth or reads `chekku_auth`. `RATE_LIMIT_TRUST_PROXY=true` opts into trusting `x-forwarded-for` for the in-process auth rate limiter; default is unset, which collapses anonymous clients onto one shared bucket per scope so XFF spoofing cannot bypass the throttle.
- Per-user stored-agent ownership is deferred to a later phase. Threads and reports are already scoped per user via `resourceId`; stored agents are not yet scoped per user.
- `AGENT_SERVICE_TOKEN`, when used, is server-only.
- The middleware auth gate never redirects `/api/*` paths. Storage and agent-proxy routes own their auth contract and return bounded JSON errors (403 from `getUserId()` returning null); redirecting them to `/login` would return HTML to clients that call `.json()` on the response. Page routes redirect to `/login` as before.
- Pages under `/public/*` are exempt from the session redirect (`PUBLIC_PATH_PREFIXES` in `client/src/server/auth-rate-limit.ts`). They are share-token gated, not session gated: `/public/slides/[analysisId]` resolves the `?t=` token through `getPublicSlides()` and 404s without a valid one. Share-link recipients have no account, so the redirect must not intercept them; signed-in users are not bounced off these paths either, so an owner can open their own link.
- `/api/storage/pm-reports` and `/api/storage/pm-reports/[reportId]` require the server identity seam and return safe bounded errors.
- `/api/storage/competitive-analyses` and `/api/storage/competitive-analyses/[analysisId]` require the same seam and return safe bounded errors.
- `/api/storage/social-posts` and `/api/storage/social-posts/[postId]` require the same server identity seam and return safe bounded errors.
- `/reports/weekly` and `/reports/[reportId]` use `client/src/server/pm-reports.ts`; `/reports/competitive` and `/reports/competitive/[analysisId]` use `client/src/server/competitive-analyses.ts`; `/social-posts` and `/social-posts/[postId]` use `client/src/server/social-posts.ts`; browser modules never import `@chekku/storage`.

### Chat file uploads

- All attachment processing happens in the browser (`client/src/lib/chat-attachments.ts` plus the browser adapters in `client/src/lib/chat-attachments-browser.ts`). The server never receives or stores files outside the chat message itself: uploads live in Mastra Memory/Postgres as message parts, exactly like any other message. There is no Garage write path and no upload API route.
- Supported inputs: text formats (txt, md, csv, tsv, json, log, xml, yml/yaml, inlined as labeled untrusted-data text blocks), images (png/jpeg/webp, passed as native multimodal image parts), and PDF (rendered to page images with `pdfjs-dist` in the browser). The OpenAI-compatible gateway only accepts `image/*` file parts — raw `application/pdf` file parts are never sent.
- Caps: at most 8 attachments per message, 256 Ki UTF-16 chars per text file, 20 PDF pages, and 8 MiB total base64 per message. Images larger than 1568 px long edge or 600 KB are downscaled/re-encoded to JPEG client-side; PDF pages render at ≤1580 px long edge. Failures surface as bounded per-file error chips with fixed messages.
- Attachment filenames are attacker-controllable prompt input: `sanitizeAttachmentFilename` (control chars collapsed, capped at 120 code points) runs at prepare time, and the merged text part labels attachment names and contents as untrusted data inside the `<!-- chekku-attachments-begin -->` … `<!-- chekku-attachments-end -->` sentinels.
- The Next.js `/api/runs` proxy forwards the client's multimodal `content` on run starts (array-only passthrough). The agent server's `parseRunContent` owns enforcement: at most 200 parts, text parts ≤ 2.5 Mi chars, image base64 ≤ 2 Mi chars per part and 8 Mi chars total, `data:` URL values rejected, optional filenames ≤ 256 chars. Violations collapse to the fixed 400 "content must be valid multimodal message parts".
- Image parts reach the model as raw base64 plus `mimeType` (never a `data:` URL string) so the OpenAI-compatible provider serializes them into `image_url` data URLs without double-wrapping. Image parts carry an optional display `filename`; PDF page parts carry `name (page i of n)`.
- Thread restore (`normalizeMessage` in `client/src/lib/memory-threads.ts`) shows the display prompt again: it cuts the text part at the first attachment sentinel instead of dumping the wrapped blob, and clamps legacy sentinel-free blobs to 128 Ki chars. Restored attachments are bounded to 24 per message, 8 Mi chars per attachment/per message, and 24 Mi chars per thread read — oversized payloads are skipped whole, never truncated into broken images.
- The char-budget guard counts user-message image file parts at the fixed `VISION_PART_ESTIMATE_CHARS` estimate (vision-encoder cost, not base64 length) and never slices binary payload fields (`data`, `image`) during truncation. When only unsliceable binary remains over budget (upload-heavy or screenshot-heavy newest turn), the guard drops whole binary units oldest-first — image file parts, standalone media parts, and binary items nested in tool-result output content — so the budget is always enforced; tool-call/tool-result pairings stay intact. Tool-result `media` (screenshots) counting is unchanged.
- The context limiter is `VisionAwareTokenLimiterProcessor` (returned by `createAgentContextLimiter()`; still a `TokenLimiterProcessor` subclass). The stock limiter feeds every non-text part through `JSON.stringify` before estimating tokens, which counts a ~130 KB page as ~25k tokens and trips the `TokenLimiterProcessor` tripwire on multi-page uploads before generation starts. The subclass counts image file parts at the fixed `VISION_PART_ESTIMATE_TOKENS` estimate and delegates all other behavior to the base implementation; the prototype shadowing is upgrade-sensitive (see the docstring note). The chat UI renders `tripwire` stream chunks as a visible assistant error ("Request stopped by a safety limit. …") instead of ending silently.
- The Mastra server sets `bodySizeLimit: 12 MiB` because upload payloads are base64-inflated message JSON; worst-case legitimate messages (8 MiB base64 plus wrapped text attachments plus the prompt) can approach that ceiling, and the production nginx template sets `client_max_body_size 12m` to match. Raise both together.
- Both configured models (`qwen3.6-35b-a3b-fast`, `qwen3.6-35b-a3b`) are multimodal. If a text-only model ever joins `LLM_MODELS`, the composer needs per-model vision gating before image/PDF upload is offered.

### Garage MCP

- Register the built-in server as `mcpServers: { garage: garageMcpServer }` in the single Mastra composition root.
- Stored-agent Garage selection persists `mcpClients: { garage: { tools: {} } }`.
- Keep the MCP registry fixed to `create_text_object`, `get_text_object`, `list_text_objects`, `replace_text_object`, and `delete_object`. Do not accept arbitrary MCP URLs, commands, packages, or credentials.
- Derive identity only from trusted `context.agent.agentId`; reject missing context before storage access and never accept agent IDs in tool input.
- Physical keys use `agents/<base64url-agent-id>/<validated-relative-key>`. Expose relative keys only.
- Enforce 512 UTF-8-byte relative keys, 262,144 UTF-8-byte text, and 100-key public lists with a `truncated` flag.
- Keep create conditional. Replace and delete run directly (no approval gate). Preserve accurate MCP annotations.
- Return fixed actionable storage errors without credentials, endpoints, headers, raw provider responses, or request IDs.

### SearXNG MCP

- Register the built-in server as `mcpServers: { searxng: searxngMcpServer }` with fixed MCP ID `searxng` and exactly one tool, `search_web`. Reject runtime registry mutation and arbitrary MCP URLs, commands, packages, headers, environment values, credentials, and tool overrides.
- PM Agent consumes the reusable `search_web` tool directly. Stored-agent SearXNG selection persists only `mcpClients: { searxng: { tools: {} } }` and hydrates the fixed in-process MCP server.
- Application configuration uses only server-owned `SEARXNG_BASE_URL` and optional `SEARXNG_API_KEY`. Keep endpoint and bearer token out of stored records, browser code, model input, tool output, logs, and safe errors.
- Keep local SearXNG service credentials and config hash private in generated `searxng/.env.local`; they are service-only state, not application configuration.
- `search_web` accepts a trimmed non-empty query of at most 1,024 UTF-8 bytes; `maxResults` is 1-20 (default 10), `page` is 1-5 (default 1), categories contain at most 5 unique values, engines contain at most 10 unique values, `safeSearch` is 0, 1, or 2, and `timeRange` is `day`, `month`, or `year`.
- Send requests only to fixed `GET {SEARXNG_BASE_URL}/config` and `POST {SEARXNG_BASE_URL}/search` paths. Use `/config` only to validate optional language, category, and engine targeting. Reject redirects and share one 12-second deadline across capability validation and search.
- POST exactly fixed form fields `q`, `format=json`, and `pageno`, plus only approved optional fields `language`, `categories`, `engines`, `time_range`, and `safesearch`. Never forward arbitrary model-provided form fields.
- Treat `maxResults` as a local deterministic slice after response normalization; do not send it upstream. Issue exactly one search request for the requested `page` and never paginate automatically.
- Accept JSON only and stop reading upstream bodies above 2 MiB. Return at most 20 results and 131,072 UTF-8 bytes total. Per result, allow only HTTP(S) URL up to 2,048 bytes, title up to 512, snippet up to 4,096, at most 8 unique engine names of 128 each, optional category up to 128, and optional finite numeric score. Include a date only when the upstream published date parses validly, normalized to ISO `publishedAt`; omit invalid dates. Return at most 5 answers of 2,048 bytes, 10 corrections of 512, and 10 suggestions of 512, with `truncated` marking omitted or shortened data.
- Return fixed actionable configuration, availability, timeout, format, size, response, targeting, and input errors. Never expose endpoint URLs, bearer tokens, search queries, upstream bodies, diagnostics, headers, or request IDs.
- Preserve MCP annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: true`; search requires no approval. This capability returns result metadata and snippets only and never downloads result pages.
- `search_web` remains discovery-only. Competitive selection, evidence synthesis, completion, and persistence belong to PM Agent's `competitive-analysis` skill.
- Keep Garage MCP unchanged at exactly its five generic object tools. SearXNG tools must never enter the Garage registry.

### Web Reader MCP

- Register the built-in server as `mcpServers: { 'web-reader': webReaderMcpServer }` with fixed MCP ID `web-reader` and exactly one tool, `read_web_page`. Reject registry mutation and arbitrary MCP URLs, subprocesses, packages, transports, endpoints, credentials, and tool overrides.
- PM Agent consumes the reusable `read_web_page` tool directly. Stored-agent Web Reader selection persists only `mcpClients: { 'web-reader': { tools: {} } }` and hydrates the fixed local in-process MCP server. Stored agents may select Garage, SearXNG, and Web Reader independently or together.
- Chekku runs its own self-hosted Jina Reader OSS container (`ghcr.io/jina-ai/reader:oss`) as a `reader` Compose service, exactly like `garage` and `searxng`. The container is stateless, unauthenticated, and ships with no API key. Application configuration uses only `WEB_READER_BASE_URL` (the in-container or loopback HTTP origin of the reader service); there is no `WEB_READER_API_KEY` and no path back to the hosted `r.jina.ai` service. Stored records contain only `mcpClients: { 'web-reader': { tools: {} } }`.
- The reader container is part of the Chekku stack's SSRF/trust boundary: every outbound fetch the agent triggers through `read_web_page` is performed by this container, not by an external provider. Operators are responsible for the network positioning of the reader service (egress filtering, resolver, proxy) the same way they are responsible for the SearXNG service. Chekku does not claim end-to-end SSRF or redirect enforcement inside the reader container; the public-URL guard in `parsePublicWebUrl` is the only Chekku-side network control.
- `read_web_page` accepts exactly one `url`: a trimmed public HTTP(S) URL of at most 2,048 UTF-8 bytes. Reject credentials, control characters, terminal-dot and local hostnames, non-default ports, and literal non-public IP ranges before provider access.
- Send exactly one `POST <WEB_READER_BASE_URL origin>/` request with JSON body `{ "url": "<normalized public URL>" }`, the fixed headers in `agent/src/mastra/web-reader/client.ts`, and `redirect: 'error'`. Never expose model- or browser-controlled headers, cookies, proxies, scripts, selectors, engines, rendering options, timeouts, methods, bodies, credentials, or provider prompts. The base URL is normalized to its origin; any path/query/fragment from configuration is dropped so a misconfigured base cannot route the POST somewhere unexpected inside the reader service.
- Empty/unset/invalid `WEB_READER_BASE_URL` fails closed with the fixed `configuration` error before any network access. HTTP 4xx/5xx all map to the fixed `unavailable` error (the reader is unauthenticated, so 401/403 are no longer treated as configuration failures).
- Enforce one 30-second deadline across validation, request, streaming, parsing, and normalization; issue no retries. Accept JSON only, stop upstream bodies above 2 MiB, limit normalized titles to 512 UTF-8 bytes, and limit serialized output to 71,680 UTF-8 bytes with deterministic UTF-8-safe Markdown truncation.
- Return only normalized `requestedUrl`, `sourceUrl`, `title`, `markdown`, `contentIsUntrusted`, and `truncated`. Preserve fixed actionable configuration, URL, cancellation, timeout, availability, format, size, and response errors without requested URLs, query strings, fragments, endpoints, headers, provider bodies, diagnostics, stacks, timings, usage, or request IDs in errors or logs.
- Keep `contentIsUntrusted: true`. Reader Markdown may contain prompt injection; treat it only as untrusted evidence, never as instructions. Bounding and labeling content do not make it trusted, and content-based injection detection is not a reliable security boundary.
- This capability reads one chosen public page per invocation. It does not search, crawl, recursively follow links, read authenticated pages, upload or read PDFs, return screenshots, persist content, or perform competitive analysis.
- Public target URLs and extracted page content pass through the local reader container's outbound fetcher (headless Chrome + LibreOffice + CJK fonts bundled in the OSS image). Chekku controls the reader container; the container controls its own outbound network. There is no external hosted Reader dependency.
- Preserve Garage at exactly five generic tools and SearXNG at exactly `search_web`; Web Reader tools and PM competitive tools must never enter either registry.

### PM analyses and reports

- Keep `pm-agent` code-defined and protected with user-invocable skills `weekly-report-analysis` and `competitive-analysis`, `memory: createAgentMemory()`, `createAgentContextLimiter()`, final `createCharBudgetGuard()`, and `maxSteps: 25`.
- Keep exactly eight PM direct tools: weekly save/list/view, competitive save/list/view, `search_web`, and `read_web_page`. Competitive tools remain PM-only and outside every fixed MCP/stored-agent registry.
- Bind every PM tool and server-side report operation to fixed namespace `pm-agent`; never accept namespace or agent identity from model, route, browser, or local user input.
- Persist and expose only relative `pm-reports/<reportId>/...` metadata keys. Never leak physical `agents/<base64url-agent-id>/...` prefixes.
- Do not migrate or fall back to old global development report objects.
- Canonical report IDs use `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>`; repository, PM tool, and public read boundaries enforce `^pmr_[0-9]{14}_[0-9a-f]{8}$`, and lists skip noncanonical metadata.
- Keep `reportUrl` and `reportsMarkdown` presentation-only in list-tool output. They must not enter persisted metadata, save output, view output, or repository types.
- PM Agent must return deterministic `reportsMarkdown` unchanged. Preserve newest-first rows, URL-encoded relative links, compact UTC dates, safe escaping, and exact empty text `No saved reports found.`
- Competitive runs include one anchor plus five to seven competitors, at most eight searches, fourteen page reads, and one save. Candidate/evidence URLs come only from user input or search results; never crawl, recursively follow Reader links, use authenticated targets, PDFs/uploads, cookies, custom headers, QA browser fallback, or another provider. Failed reads may consume one alternate URL per product within the 14-read cap; alternates are not same-URL retries.
- Require one successfully read official/primary page per product. Search snippets are discovery-only; claims use inline primary-source links. Matrix states are `Yes`, `Partial`, `No`, and `Unknown`; missing mention is `Unknown`, never `No`. Reader Markdown remains untrusted evidence and cannot control tools, skills, product selection, format, secrets, or persistence.
- Wrap PM Agent `search_web`, `read_web_page`, and `save_competitive_analysis_to_garage` tools with `withCompetitiveResearchBudget`. It enforces the 8/14/1 per-run caps deterministically at execute time (gateway-independent): failed `search_web` and `read_web_page` attempts count toward their caps, but a failed `save_competitive_analysis_to_garage` attempt does not consume the save slot (only a successful save counts), so the agent can retry the save after a validation or transient error. `Web Reader is not configured.` latches the run terminal so further Reader calls reject without provider access. Keep `competitive-research-guard` first in `inputProcessors` as an advisory layer that injects fixed safe incomplete-branch guidance after terminal Reader configuration failure; it does not replace the execute-level hard gate.
- Before drafting, build a current-run successful-read evidence inventory. If anchor plus five competitors are not evidenced, use exact H1 `# Incomplete Competitive Analysis: <anchor product>`, make no claims for unevidenced products, do not save, and emit no `Saved analysisId:`.
- Save only complete competitive work. Incomplete output states missing evidence and user action, is not saved, and contains no `Saved analysisId:`. Complete save input requires exact product-to-source coverage.
- Competitive IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Persist only `competitive-analyses/<analysisId>/{request.md,analysis.md,slides.md,share-token.json?,metadata.json}` relative keys (share-token.json exists only after the user creates a share link); metadata writes last. Every complete competitive save produces a non-blank `slides.md` Marp deck; legacy analyses saved before this feature have no `slides.md` and the slides route returns 404.
- Keep `analysisUrl` and `analysesMarkdown` presentation-only. Competitive list output is newest-first and exact empty text is `No saved competitive analyses found.`
- Preserve routes `/reports`, `/reports/weekly`, `/reports/<pmr-id>`, `/reports/competitive`, `/reports/competitive/<pca-id>`, `/reports/competitive/<pca-id>/slides`, and `/public/slides/<pca-id>` (unauthenticated, token-gated via `?t=<32-hex>` query param); existing weekly and competitive links must not move.
- `/public/slides/<pca-id>?t=<token>` is the only unauthenticated PM route. The server seam `getPublicSlides` reads ONLY `share-token.json` (validates token) and `slides.md` (renders deck). It must NEVER read `metadata.json`, `analysis.md`, `request.md`, or any other Garage key. All failures (missing token, wrong token, missing slides, storage outage) collapse to 404 to avoid leaking whether an analysis exists.
- The slides route renders the saved `slides.md` through `@marp-team/marp-core` in a client component. The route is server-rendered through `client/src/server/competitive-analyses.ts` and the same identity seam as the rest of `/reports/*`; no public access, no Chromium on the server, no PPTX export in v1. Print-to-PDF uses `window.print()` and print CSS only.
- Keep chat tables horizontally scrollable, keyboard focusable, labeled as regions, and visibly outlined on focus. Report lists render as accessible card grids (mirroring the agent-card visual language: glyph, badge, title, `<code>` id, meta `<dl>`, action; `role="list"` region with `aria-label`, focusable detail links, hover lift).
- Preserve generic Garage MCP at exactly five generic tools. PM report tools must never enter its registry.
- Garage v2.3 external writers can race checked mutations; do not claim cross-process conditional-write guarantees.

### Social post drafts

- The scheduled `weekly-social-drafts` workflow is the only **creator** of social posts (post body plus initial metadata). It binds storage to fixed namespace `social-media-agent`; never accept namespace or agent identity from model, route, browser, or local user input. After a post exists, the only permitted mutations are the two narrow metadata helpers named above (`attachVisualAsset`, `updateSocialPostStatus`); there is no general social-post write path. Chat drafting is ephemeral text only — it must not create or persist a post.
- Dev-only manual workflow trigger: `POST /api/storage/social-posts/run-weekly-drafts` (gated to non-production, identity-checked via `requireUserId()`) starts `weekly-social-drafts` fire-and-forget (calls the agent server directly with the downstream token — not the cookie-gated `mastraClient` loop-back) so a developer can produce real `DRAFT` posts on demand. The "Run weekly drafts now" button on `/social-posts` calls it. Production exposes neither the route nor the button.
- Workflow writes go through the existing Garage MCP `create_text_object` tool with a trusted context that pins `agentId` to `social-media-agent`. The workflow must not call `@chekku/storage` write APIs directly or bypass the MCP tool's namespace derivation.
- Each weekly fire drafts 2 base Instagram posts plus, when the week contains a fixed-date awareness day, 1 bonus awareness-day post (total 2–3 drafts). The 2 base slots come from SearXNG trending research via the reusable `search_web` tool (`agent/src/mastra/workflows/trending-research.ts` consumes the tool through a `SearchFn` seam — snippet-only, no page crawling). Remaining base slots are filled from the deterministic evergreen-pillar rotation when research yields fewer than 2 topics. Trending results whose title or snippet overlaps the chosen awareness day are skipped so the bonus and a base slot do not duplicate the same theme. Every entry in `SPECIAL_DAYS` is eligible as a bonus, including national holidays such as `08-17`.
- Awareness-day bonus candidates are merged from two sources via async `selectBonusAwarenessDayForWeek`: (1) the Public Holiday Indonesia API (`agent/src/mastra/calendar/public-holidays.ts`) for movable feasts and national/religious holidays — Idul Fitri, Idul Adha, 1 Muharram / Tahun Baru Islam, Isra Mi'raj, Maulid Nabi, Nyepi, Paskah, Waisak, Natal, and cuti bersama (the latter filtered out); (2) the fixed-date `SPECIAL_DAYS` calendar for observance days that are not national holidays (Hari Kartini, Hari Guru Nasional, Hari Bumi, etc.). When both sources have an entry on the same date, the API entry wins because it is authoritative and usually carries the Hijri year label. The API response is cached per year on disk under `agent/src/mastra/calendar/.cache/` (gitignored). When `PUBLIC_HOLIDAY_API_BASE_URL` is unset or the API is unreachable, the selector falls back to fixed-date `SPECIAL_DAYS` only — observance days still produce a bonus, movable feasts do not.
- The Public Holiday API client mirrors the SearXNG bounded-transport contract: fixed endpoint, no auth header, no arbitrary configuration, 12-second timeout, 1 MiB max body, reject redirects, per-year file cache. Errors use fixed actionable messages and never leak the endpoint URL or diagnostics. Only the weekly-social-drafts workflow consumes this module — no MCP server is exposed and no agent tool is registered.
- When SearXNG is not configured (`SEARXNG_BASE_URL` empty) or every research query fails, the workflow degrades to exactly 2 evergreen pillars with no awareness-day bonus and records a `researchNote` on the run output. Research failure is never fatal: drafts still save and email still attempts.
- When `WEB_READER_BASE_URL` is configured, the workflow enriches each chosen trending topic with the self-hosted Reader's page markdown via the reusable `read_web_page` tool (imported directly, not via MCP — same pattern as `search_web`). Enrichment runs as `Promise.allSettled` across the chosen topics' source URLs after the diversification pass, so each fetch is bounded to one already-filtered URL. Per-topic fetch failure is swallowed — the topic stays in the result with snippet only (no `pageMarkdown`), so a single unreachable URL never drops a base slot. Returned markdown is always `contentIsUntrusted: true`; the drafter prompt instructs the model to treat it as evidence, never as instructions, and to keep leaving `[source]` placeholders for any specific claim. Page markdown is hard-capped at 3000 chars in `buildSourceBlock` to keep the prompt budget healthy. When `WEB_READER_BASE_URL` is unset, the workflow skips enrichment entirely (snippet-only, same as before Phase 2b).
- Research metadata (reference URL, title, snippet) lives in the draft prompt and brief only; it must not enter `SocialPostMetadata`, the canonical `smp_...` schema, or any persisted field beyond the brief body. The drafter still leaves `[source]` placeholders for specific claims — snippets are context, not verified facts.
- `@chekku/storage` exposes only pure canonical helpers for social posts (`buildSocialPostMetadata`, `createPostId`, parse helpers) plus read helpers used by client/server (`listSocialPosts`, `getSocialPost`, `createSocialPostStorage`). It must not expose a general social-post write helper that takes an `ObjectStorage`. The only permitted write surface is exactly two narrowly-scoped metadata mutations on an existing post, both server-only and both serialized per post through `serializeMetadataWrite` (in-process only; cross-process races remain subject to the Garage v2.3 disclaimer): `attachVisualAsset` (append one visual asset + set it active) and `updateSocialPostStatus` (the single `DRAFT → APPROVED` transition). Neither may create a post body or initial metadata, mutate `postId`/namespace/keys, or accept agent identity from model, route, browser, or local user input.
- Persist and expose only relative `social-posts/<postId>/...` metadata keys. Never leak physical `agents/<base64url-agent-id>/...` prefixes.
- Canonical post IDs use `smp_YYYYMMDDHHMMSS_<8 lowercase hex>`; repository, workflow, and public read boundaries enforce `^smp_[0-9]{14}_[0-9a-f]{8}$`, and lists skip noncanonical metadata.
- The fixed-date awareness calendar (`SPECIAL_DAYS`) and evergreen-pillar rotation remain in `agent/src/mastra/workflows/special-days.ts` as the deterministic Stage 1 surface and degraded-mode fallback. Movable feasts are resolved at runtime by the Public Holiday API client in `agent/src/mastra/calendar/public-holidays.ts`, not hardcoded in `SPECIAL_DAYS`.
- Stage 1 topic selection uses the hardcoded fixed-date awareness calendar plus evergreen pillars. Stage 2 augments base-slot topic selection with SearXNG research without changing voice, storage, or notification.
- Stage 1 only creates objects; it does not replace or delete. Email delivery failure is recorded, not fatal — saved drafts remain readable.
- Social-post tools must never enter the generic Garage MCP registry.

### Production containerization

- Development and production are kept apart by Compose profiles, not by separate files. The `agent` and `client` services in `compose.yaml` are gated behind `profiles: [prod]`. `scripts/dev.sh` never activates the `prod` profile and continues to run the agent and client as host processes with only Garage, SearXNG, Reader, and Postgres in containers. `scripts/prod.sh` is the only path that activates the profile and brings the whole stack up as containers.
- Profile service interpolations must use `${VAR:-}` defaults (never `${VAR:?}`), so `scripts/dev.sh`'s `docker compose config --quiet` validation still passes without production secrets present. The only place that fails closed on missing production values is `scripts/prod.sh` (`POSTGRES_PASSWORD`, `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL`).
- `agent/Dockerfile` and `client/Dockerfile` build from the repository root (not the workspace directory) because `npm ci` must resolve the `@chekku/storage` workspace symlink and each bundler must follow `storage/`. Both images are multi-stage and emit a runtime stage only.
- The agent image installs system Chromium because `@mastra/agent-browser` depends on `playwright-core`, which does not download a browser. `BROWSER_EXECUTABLE_PATH` points at the system binary; `agent/src/mastra/browsers.ts` passes it to `AgentBrowser` as `executablePath`. Playwright has no environment variable for selecting a system browser, so this must stay a code path — an env-only name such as `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is silently ignored and every browser tool then fails with `Executable doesn't exist at /root/.cache/ms-playwright/...`. The QA Android Agent (Maestro) stays host/device-only: `MAESTRO_ENABLED` is forced to `false` in the agent container and must not be enabled there.
- The client image relies on `client/next.config.ts` setting `output: 'standalone'`, `outputFileTracingRoot` to the repo root, and `transpilePackages: ['@chekku/storage']`. Standalone file tracing pulls `@aws-sdk/client-s3` (a storage dependency) into `.next/standalone/`; `@chekku/storage` is transpiled into the server bundle. Do not remove any of these three settings.
- Mastra currently inlines `@chekku/storage` into the agent bundle, but the agent runtime stage copies the `storage/` workspace so the runtime layout matches the build layout even if a future Mastra version externalizes storage via an absolute path. The runtime stage's final `WORKDIR` is `/app/agent` so the relative `CMD ["node", ".mastra/output/index.mjs"]` resolves against the built output; the `/app` base keeps build-time and runtime paths aligned.
- In-container wiring is fixed: the agent binds `HOST=0.0.0.0` and does not publish port `4111`; the client's same-origin proxy targets `AGENT_URL=http://agent:4111` over the Compose default network; `DATABASE_URL` uses the `postgres` service hostname; SearXNG is reached at `http://searxng:8080`; only the client publishes a port and only on loopback (`127.0.0.1:3000`) for a reverse proxy to terminate TLS.
- Secrets reach containers exclusively through Compose `environment:` interpolation. `scripts/prod.sh` parses the four dotenv files (`storage/.env.local`, `searxng/.env.local`, `agent/.env`, `client/.env.local`) with node+dotenv — never bash `source`, which cannot parse values containing spaces or special characters (`LLM_DISPLAY_NAME=Rafiqspace LLM`, `RESEND_FROM_EMAIL=Chekku <...>`). No secret is baked into either image. Service-only secrets (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`, `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`) may be present in Compose's interpolation context, but they never enter the agent or client containers because their `environment:` blocks do not declare them; `SEARXNG_SECRET` and `SEARXNG_CONFIG_HASH` legitimately reach the `searxng` container, which declares them.
- Do not add a `prod` override that publishes the agent port, exposes Garage/SearXNG internal ports, or moves the client off loopback without a reviewed configuration change. A gitignored `docker-compose.override.yaml` is the supported escape hatch for machine-specific bindings.

## Coding conventions

- Use TypeScript strict mode and explicit types at external boundaries.
- Prefer small focused modules with one responsibility.
- Follow existing import ordering: external packages, blank line, internal modules.
- Use named exports for reusable helpers.
- Validate untrusted route, model, and thread inputs before use.
- Preserve errors that help the user act; do not expose secrets or raw credentials.
- Keep UI state harmless and local. Persist only preferences such as sidebar width/collapse state.
- Do not add dependencies when the standard library or an existing dependency is sufficient.
- Do not perform unrelated folder reorganizations while implementing a feature.

## Testing rules

Add regression tests for behavior changes, especially:

- model ID normalization and discovery fallback;
- system-message ordering;
- stored-agent payloads and migrations;
- thread ID creation and ownership;
- proxy URL validation and method support;
- the agent run lifecycle: registry concurrency (409 on duplicate non-terminal runs, 429 concurrency caps with intact registry state, duration watchdog force-fail releasing the thread lock), cancel idempotency, event replay from offset, buffer eviction and terminal TTL, ownership collapse to 404 (handler level), events-route heartbeat cleanup, execution driver terminal states (completed/failed/cancelled) and `tool-error` chunk mapping, server-side first-turn thread creation and titling at run start (`ensureFirstTurnThread`), run summaries carrying the prompt, the `/api/runs` seam (resourceId injection, thread-ownership rejection), SSE parsing and offset reconnect in `client/src/lib/agent-runs.ts` (including split multi-byte UTF-8 chunks), and ChatStudio reconnection behavior (active-run discovery on mount with prompt synthesis, no duplicate start on 409, navigation unblocked while running, run-state reset on thread switch, run-scoped stop, thread-list refresh on start, sidebar running indicator);
- sidebar and route structure;
- shared Garage storage, namespace isolation, weekly and competitive PM repositories/tools/skills/APIs/pages/tables, social posts/APIs/pages/tables, fixed Garage, SearXNG, and Web Reader MCP hydration, bounded SearXNG search and self-hosted page reading, competitive research budget enforcement and terminal Reader configuration latch, Public Holiday Indonesia API client (parsing + filtering + cache + bounded transport), scheduled workflow trending research (credible-source whitelist + homepage filter + diversification) + Web Reader page-markdown enrichment (parallel fetch, per-topic fallback, prompt-injection-safe truncation) + topic composition + format split (Folkative-style caption for trending, greeting-card copy for awareness days/evergreen) + awareness-day bonus (fixed-date + Public Holiday API merge) + degraded-mode fallback, and launcher structure;
- QA agent Memory and browser integration.
- Social agent roles, Telegram slash registration, email delivery behavior, and the scheduled social-drafts workflow.
- Visual Content Agent self-review loop (Pembahasan 1): bounded multimodal review-client transport and error normalization, `review_image` asset verification + bytes dispatch + advisory verdict resolution, and `generate_image` regeneration cap (`MAX_VISUAL_ASSETS_PER_POST`) checked after the approval gate.

Tests use Vitest. Keep tests alongside the relevant module or in the existing `__tests__` folder. Do not add a second test runner for new tests.

Test-runner quirks:

- Root `npm test` runs three vitest invocations: the main suite (excluding `scripts/dev.test.ts` and `scripts/prod.test.ts`), then each of those two script tests in isolation. Run one file with `npx vitest run <path>` from the root.
- Root `vitest.config.ts` discovers tests only as `*.test.ts`/`*.test.tsx` under `agent/src`, `client/src`, `scripts`, and `storage/src`. Default environment is `node`; DOM tests opt in per file with `// @vitest-environment jsdom`. The `@/` alias maps to `client/src/`; timeout is 15 seconds.
- `vitest.setup.js` pins `WEB_URL` and swaps `@mastra/pg`'s `PostgresStore` for an in-memory store, so unit tests import the Mastra composition root without a running Postgres.
- `npm run test:web-reader:live` is a live smoke test that activates only under its own script name (`npm_lifecycle_event` guard); it never runs in `npm test` or CI.

## Documentation rules

Update documentation when changing:

- environment variables;
- public routes;
- repository commands;
- storage behavior;
- model gateway behavior;
- authentication or authorization boundaries;
- agent/thread invariants.

The root `README.md` is the public onboarding document. `docs/ARCHITECTURE.md` describes only the current system. Historical removals belong in `docs/CLEANUP_MANIFEST.md`, not in live source code.

## Files that must not be committed

- `.env` and `.env.local` files containing secrets, including `searxng/.env.local`;
- `node_modules/`, `.next/`, `.mastra/`, `dist/`, coverage, and TypeScript build info;
- Postgres data lives in a Docker volume; do not commit database volumes or any leftover local database files (e.g. legacy `mastra.db*`);
- browser recordings, Playwright output, screenshots used only for local debugging;
- installer backups, ZIP packages, patch files, and worktree pointers.

## Completion checklist

Before claiming completion:

- [ ] The change follows the active architecture.
- [ ] No secret or local state is added.
- [ ] Affected tests were added or updated.
- [ ] `npm run check` passes.
- [ ] `npm run build` passes, or an external-only limitation is documented with source restored unchanged.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] README and operational docs match any changed commands or environment variables.
