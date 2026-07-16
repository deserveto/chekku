# AGENTS.md

This file defines the operating rules for coding agents and contributors working in the Chekku repository. Follow it before changing source, tests, configuration, or documentation.

## Mission

Chekku is a local-first agent studio built from three npm workspaces:

- `agent/`: Mastra server, code-defined agents, stored-agent runtime, Memory, LibSQL, browser automation, tools, and model gateway.
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
6. `client/src/server/pm-reports.ts` — authenticated server-only PM report boundary.
7. `agent/src/mastra/mcp/garage-mcp-server.ts` — built-in generic Garage MCP capability.
8. `agent/src/mastra/gateways/openai-compatible.ts` — final model transport.
9. `docs/ARCHITECTURE.md` — runtime structure and data flow.
10. `docs/OPERATIONS.md` — environment and troubleshooting.

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

## Architecture invariants

### One Mastra runtime

- Keep `agent/src/mastra/index.ts` as the single server composition root.
- Custom server routes are limited to `/healthz` and `/models` unless a new requirement cannot use Mastra's native APIs.
- Do not recreate custom `/api/conversations`, `/api/chat`, `/api/builder`, or raw-SQL agent routes.

### Stored agents

- Use `@mastra/editor` for stored-agent creation, versioning, persistence, and hydration.
- Use `client/src/lib/stored-agents.ts` and the Mastra client instead of direct database access.
- Code-defined agents are protected and must not be edited or deleted through stored-agent APIs.
- Preserve stored-agent model migration through `client/src/lib/stored-agent-migration.ts`.
- Stored agents may reference registered tools and delegate agents by ID; do not persist API keys in agent records.

### Storage and conversations

- `LibSQLStore` is the sole Mastra storage implementation.
- Generic Garage object access belongs in `storage/`, not agent-private or browser modules.
- Garage MCP and server-side code share `@chekku/storage`; browser components must never import it or access Garage directly.
- PM report persistence composes the generic contract in `storage/src/pm-reports.ts`; it must not add PM semantics to Garage MCP.
- Garage application configuration uses only `GARAGE_ENDPOINT`, `GARAGE_REGION`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY_ID`, and `GARAGE_SECRET_ACCESS_KEY`.
- Generated `storage/.env.local`, `storage/.garage/`, and `agent/.env.development` stay ignored. Never expose their secrets in logs, docs, errors, or commits.
- Conversation history uses Mastra Memory, not custom conversation tables.
- Every agent must bound its context to prevent overflow: use `createAgentMemory()` (sets `lastMessages`) and add `createAgentContextLimiter()` (a `TokenLimiterProcessor`) to `inputProcessors`, both from `agent/src/mastra/processors/context-limit.ts`. Never use bare `new Memory()` — large tool outputs (screen/HTML dumps) can exceed the model window across turns or within a single multi-step turn; the token limiter prunes both.
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
```

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

- `qa-web-agent` must keep `memory: new Memory()` because browser context processing requires active Memory context.
- Keep the gateway compatibility processor unless tests prove it is no longer needed.
- No tool requires approval; browser actions (form submit, purchase, publish, delete) run directly.
- Do not add endpoint-specific discovery tools to the QA agent. Model discovery belongs in the gateway and `/models` route.

### QA Android Agent

- Keep `qa-android-agent` code-defined with Mastra Memory and the gateway compatibility processor.
- Bind a trusted, env-gated `MCPClient` to `maestro mcp` privately on this agent only; do not add it to the global `mcpServers` (which stays fixed to `garage`).
- Expose only the explicit Maestro tool allowlist (`list_devices`, `inspect_screen`, `take_screenshot`, `cheat_sheet`, `run`); never expose `run_flow_files`, cloud tools, or `open_maestro_viewer`. Never auto-attach every tool from `listTools()`.
- No tool requires approval; `maestro_run` (flow execution, incl. inline/generated YAML) and the curated `run_maestro_flow` run directly. There are no granular single-action tools.
- A read-only `current_app` tool (adb-backed via `ADB_PATH`) returns the foreground app's package so the agent can self-serve the `appId` instead of asking; it never mutates the device.
- On Windows, route the Maestro `.bat`/`.cmd` command through `cmd.exe /c` (Node blocks direct `.bat` spawn since CVE-2024-27980).
- The curated flow runner accepts logical `{ suite, flow }` names only; reject absolute paths, `..`, backslashes, caller-supplied extensions, and non-regular files; resolve real-path containment after symlinks.
- Run flows via `execFile` with an argv array (never a shell string), `--format junit --output` and `--test-output-dir` into `artifacts/maestro/<runId>/`, with `MAESTRO_TIMEOUT_MS`, bounded output, and child cleanup.
- Never report a test Passed unless Maestro exited 0.
- `MAESTRO_ENABLED` defaults to `false`; the server boots normally without Maestro.

### Social Media Agent

- Keep `social-media-agent` code-defined with Mastra Memory, Telegram channel integration, role switching, and the `send-email` tool.
- Preserve `/help`, `/roles`, `/role`, and `/switch` registration after `AgentChannels` initialization.
- Telegram uses `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MODE`, optional `TELEGRAM_BOT_USERNAME`, and optional `TELEGRAM_WEBHOOK_SECRET_TOKEN` only.
- Email uses server-only `RESEND_API_KEY` and `RESEND_FROM_EMAIL`; never expose either to browser code.
- Outbound email and channel actions run directly (no approval gate).

### Client proxy and identity

- Browser-to-Mastra agent-service requests target the Next.js origin and pass through `/api/agent/*`. PM report pages stay under `/reports/*`, and PM report storage APIs stay under `/api/storage/pm-reports/*` in the Next.js server.
- The proxy must continue supporting `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`.
- Validate upstream paths with `client/src/server/proxy-url.ts`.
- `CHEKKU_LOCAL_USER_ID` is a temporary local identity seam. Replace it with OIDC later without changing thread-ownership semantics.
- `AGENT_SERVICE_TOKEN`, when used, is server-only.
- `/api/storage/pm-reports` and `/api/storage/pm-reports/[reportId]` require the server identity seam and return safe bounded errors.
- `/reports` and `/reports/[reportId]` use `client/src/server/pm-reports.ts`; browser modules never import `@chekku/storage`.

### Garage MCP

- Register the built-in server as `mcpServers: { garage: garageMcpServer }` in the single Mastra composition root.
- Stored-agent Garage selection persists `mcpClients: { garage: { tools: {} } }`.
- Keep the MCP registry fixed to `create_text_object`, `get_text_object`, `list_text_objects`, `replace_text_object`, and `delete_object`. Do not accept arbitrary MCP URLs, commands, packages, or credentials.
- Derive identity only from trusted `context.agent.agentId`; reject missing context before storage access and never accept agent IDs in tool input.
- Physical keys use `agents/<base64url-agent-id>/<validated-relative-key>`. Expose relative keys only.
- Enforce 512 UTF-8-byte relative keys, 262,144 UTF-8-byte text, and 100-key public lists with a `truncated` flag.
- Keep create conditional. Replace and delete run directly (no approval gate). Preserve accurate MCP annotations.
- Return fixed actionable storage errors without credentials, endpoints, headers, raw provider responses, or request IDs.

### PM reports

- Keep `pm-agent` code-defined and protected, with `memory: new Memory()` and tools `save_pm_report_to_garage`, `list_pm_reports_from_garage`, and `view_pm_report_from_garage` registered only on that agent.
- Bind every PM tool and server-side report operation to fixed namespace `pm-agent`; never accept namespace or agent identity from model, route, browser, or local user input.
- Persist and expose only relative `pm-reports/<reportId>/...` metadata keys. Never leak physical `agents/<base64url-agent-id>/...` prefixes.
- Do not migrate or fall back to old global development report objects.
- Canonical report IDs use `pmr_YYYYMMDDHHMMSS_<8 lowercase hex>`; repository, PM tool, and public read boundaries enforce `^pmr_[0-9]{14}_[0-9a-f]{8}$`, and lists skip noncanonical metadata.
- Keep `reportUrl` and `reportsMarkdown` presentation-only in list-tool output. They must not enter persisted metadata, save output, view output, or repository types.
- PM Agent must return deterministic `reportsMarkdown` unchanged. Preserve newest-first rows, URL-encoded relative links, compact UTC dates, safe escaping, and exact empty text `No saved reports found.`
- Keep chat and report-list tables horizontally scrollable, keyboard focusable, labeled as regions, and visibly outlined on focus.
- Preserve generic Garage MCP at exactly five generic tools. PM report tools must never enter its registry.
- Garage v2.3 external writers can race checked mutations; do not claim cross-process conditional-write guarantees.
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
- sidebar and route structure;
- shared Garage storage, namespace isolation, PM reports/APIs/pages/tables, MCP hydration, and launcher structure;
- QA agent Memory and browser integration.
- Social agent roles, Telegram slash registration, and email delivery behavior.

Tests use Vitest. Keep tests alongside the relevant module or in the existing `__tests__` folder. Do not add a second test runner for new tests.

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

- `.env` and `.env.local` files containing secrets;
- `node_modules/`, `.next/`, `.mastra/`, `dist/`, coverage, and TypeScript build info;
- `mastra.db`, WAL, SHM, SQLite, or other local database files;
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
