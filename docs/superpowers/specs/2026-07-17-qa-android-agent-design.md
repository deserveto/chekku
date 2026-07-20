# QA Android Agent — Design Spec

**Date:** 2026-07-17
**Status:** Approved, revised (pre-implementation)
**Scope:** Add code-defined Mastra agent `qa-android-agent` that performs Android application QA through Maestro.

---

## 1. Goal

Add a code-defined Mastra agent, `qa-android-agent`, that drives Android app QA through
[Maestro](https://maestro.mobile.dev/)'s local MCP server. The agent reuses Chekku's existing
server model gateway, Mastra Memory, gateway compatibility processor, and request-context approval
flow. It is the mobile counterpart to `qa-web-agent`.

## 2. Non-goals (out of scope)

- APK upload UI.
- Maestro Cloud integration (cloud tools are not exposed).
- Multi-device parallel testing.
- Automatic GitHub/Jira issue creation.
- Arbitrary command execution surfaces.
- Automatic commits of model-generated YAML.
- Android screen streaming inside Chekku.
- Unrelated architectural refactors.

Automated tests are unit-level against the deterministic pieces. **Manual acceptance verification
on a real emulator or device is required before the PR is considered complete** (see §14).

## 3. Context from the existing codebase

The design reuses established patterns:

- **`qa-web-agent`** (`agent/src/agents/qa-web-agent.ts`) — the structural template: shared
  `getServerModel()`, `Memory`, `gatewayCompatibilityProcessor`, request-context-driven
  `defaultOptions.requireToolApproval`, and a pure `shouldApproveQaWebTool(...)` classifier.
- **`social-media-agent`** — the resilience template: a subsystem (Telegram adapter) is constructed
  only when its env toggle is set, so the server boots cleanly when the optional dependency is
  absent. Maestro follows the same pattern via `MAESTRO_ENABLED`.
- **`pm-agent` + `pm-report-tools.ts`** — the curated-tool template: a protected code-defined
  agent owns tools that compose a server-controlled, namespace-bound capability with strict input
  validation.
- **`providerContextSchema`** (`agent/src/agents/context.ts`) — the request-context seam that today
  carries `browserAccess`. `mobileAccess` is added alongside it, not reused from it.
- **`config/env.ts`** — the single Zod-validated environment schema that all new `MAESTRO_*`
  variables extend.

### Maestro MCP tool surface

Maestro's MCP server exposes a **granular** tool set covering device control, UI inspection,
interaction, flow validation, and documentation lookup. The exact names exposed by the running
`maestro mcp` version are discovered at runtime via `listTools()`, but the design targets the
current documented surface, which includes tools such as `list_devices`, `start_device`,
`inspect_view_hierarchy`, `take_screenshot`, `tap_on`, `input_text`, `back`, `launch_app`,
`stop_app`, `run_flow`, `check_syntax`, `cheat_sheet`, and `query_docs`, alongside file-based
runners such as `run_flow_files`.

Chekku does **not** blindly attach everything `listTools()` returns. It exposes only an explicit
allowlist (§4.1) and explicitly excludes path-based runners and any cloud tooling.

## 4. Architecture

```text
qa-android-agent
├── model:           getServerModel()                  (shared OpenAI-compatible gateway)
├── memory:          new Memory()                      (active Memory, like qa-web)
├── inputProcessors: [gatewayCompatibilityProcessor]
├── requestContextSchema: providerContextSchema        (adds mobileAccess)
│
├── tools (lazy-resolved):
│     ├── <allowlisted Maestro MCP tools, namespaced maestro_*>
│     │     read-only:   maestro_list_devices, maestro_inspect_view_hierarchy,
│     │                  maestro_take_screenshot, maestro_check_syntax,
│     │                  maestro_cheat_sheet, maestro_query_docs
│     │     granular:    maestro_tap_on, maestro_input_text, maestro_back,
│     │                  maestro_launch_app, maestro_stop_app, maestro_start_device
│     │     flow:        maestro_run_flow  (inline/generated YAML — always approved)
│     ├── run_maestro_flow        (curated checked-in YAML runner — §6)
│     ├── calculatorTool          (harmless shared tool)
│     └── getCurrentTimeTool      (harmless shared tool)
│
└── defaultOptions.requireToolApproval:
        shouldApproveQaAndroidTool(requestContext.get('mobileAccess'), toolName)
```

### 4.1 Maestro MCP client + allowlist (requirements 1 & 2)

A single trusted `MCPClient` instance, created server-side only. The transport is stdio and the
command/args come **exclusively** from validated environment variables:

```ts
new MCPClient({
  servers: {
    maestro: {
      command: env.MAESTRO_COMMAND,   // 'maestro'
      args: ['mcp'],
      // No env, no url, no credentials from model/user input.
    },
  },
  timeout: env.MAESTRO_TIMEOUT_MS,
});
```

- Constructed **only when `MAESTRO_ENABLED === 'true'`**. The default is `'false'`, so Chekku boots
  normally on machines without Maestro installed. When disabled, the agent registers without any
  Maestro MCP tools (mirrors `social-media-agent` without `TELEGRAM_BOT_TOKEN`).
- `tools` is a `DynamicArgument` (async function) that memoizes the result of loading + filtering
  the MCP tools, so the subprocess connects lazily on first agent use, never at module import. A
  missing or hung maestro binary therefore cannot block server boot.
- **Allowlist filter.** After `mcpClient.listTools()` returns the namespaced `maestro_*` map, a
  `filterMaestroTools(tools)` helper keeps only the explicit allowlist below. Anything else the
  server advertises (now or in a future version) is dropped before the model ever sees it.
- Tool names arrive namespaced as `maestro_<tool>` (MCPClient convention), which the approval
  classifier keys on.

**Exposed allowlist** (logical names, before the `maestro_` prefix):

| Logical name | Tier |
|---|---|
| `list_devices`, `inspect_view_hierarchy`, `take_screenshot`, `check_syntax`, `cheat_sheet`, `query_docs` | read-only |
| `tap_on`, `input_text`, `back`, `launch_app`, `stop_app`, `start_device` | granular interaction |
| `run_flow` | inline/generated flow (always approved) |

**Explicitly excluded** (never attached even if advertised):

- `run_flow_files` — accepts arbitrary absolute file paths; replaced by the curated
  `run_maestro_flow` runner which only accepts logical `{ suite, flow }` names.
- Any cloud tool (`run_on_cloud`, `list_cloud_devices`, `get_cloud_run_status`,
  `open_maestro_viewer`, etc.).
- Any tool not in the allowlist above.

The allowlist is the single source of truth for both filtering and approval classification.

## 5. Request context & approval (requirements 5 & 6)

`providerContextSchema` gains a sibling of `browserAccess`:

```ts
z.object({
  browserAccess: z.enum(['approval', 'full']).optional(),
  mobileAccess:  z.enum(['approval', 'full']).optional(),
})
```

`browserAccess` continues to drive `qa-web-agent` only; `mobileAccess` drives `qa-android-agent`
only. They are never reused across agents.

A single pure classifier — `shouldApproveQaAndroidTool(mobileAccess, toolName)` — is wired into the
agent's `defaultOptions.requireToolApproval`, exactly like `qa-web-agent`. Approval is decided at
the agent level (not via MCPClient's per-server `requireToolApproval`) so one function classifies
every tool regardless of source, and so the pattern matches the existing QA agent.

| Tool (namespaced) | `mobileAccess` = `'approval'` or unset | `'full'` | Tier |
|---|---|---|---|
| `maestro_list_devices`, `maestro_inspect_view_hierarchy`, `maestro_take_screenshot`, `maestro_check_syntax`, `maestro_cheat_sheet`, `maestro_query_docs` | no approval | no approval | read-only |
| `maestro_tap_on`, `maestro_input_text`, `maestro_back`, `maestro_launch_app`, `maestro_stop_app`, `maestro_start_device` | **approve** | no approval | granular interaction |
| `maestro_run_flow` (inline / generated YAML) | **always approve** | **always approve** | high-impact: dynamically generated / untrusted flow |
| `run_maestro_flow` (checked-in, trusted flow) | **approve** | no approval | curated runner |
| `calculator`, `getCurrentTime` | no approval | no approval | harmless |

Defaults: when `mobileAccess` is unset, interaction tools and the curated runner are gated
(approve) — the safe default.

The agent's instructions additionally require it to describe consequential semantic actions
(purchases, sending messages, account deletion, password changes, clearing app data, publishing)
before taking them and to request approval — defence in depth alongside the tool-level gate.

## 6. Controlled flow runner (requirement 7) — the security-critical piece

`run_maestro_flow` is a code-defined tool that runs **checked-in** Maestro YAML only.

**Input:** `{ suite: 'smoke' | 'regression' | 'shared', flow: string }`
(example: `{ suite: 'smoke', flow: 'login' }`).

### 6.1 Path resolution — pure, fully testable

`resolveMaestroFlowPath(suite, flow, workspaceAbs)`:

1. `suite` must be in the fixed set `{ smoke, regression, shared }`.
2. `flow` must match `^[a-z0-9-]+$` (logical name only; no extension, no slash, no dot).
3. Build relative path `<suite>/<flow>.yaml`; reject any input containing `\`, `..`, a drive
   letter, a leading separator, or a caller-supplied `.yaml`/`.yml` suffix.
4. The `workspaceAbs` is **already absolute** — workspace and artifact dirs are resolved to
   absolute paths once at config load (see §8).
5. Join to `workspaceAbs`, then `fs.realpath()` the result (resolves symlinks).
6. **Containment:** confirm the real-resolved flow path still starts with the real-resolved
   `workspaceAbs` after symlink resolution. Reject otherwise.
7. `fs.stat()` the resolved path and confirm it is a **regular file**. Reject directories,
   symlinks-to-nowhere, sockets, etc.
8. Return the absolute path or throw a fixed actionable error that never leaks physical paths
   beyond the workspace root.

### 6.2 Execution — safe child process + bounded output + JUnit report

`runMaestroFlow({ suite, flow }, options)`:

- Resolves the path via §6.1.
- Creates a run directory `<artifactDirAbs>/<runId>/` (`runId` = timestamp + random suffix), with
  the artifact dir already resolved to absolute once at config load.
- Executes via **`execFile`** with an argv array — never an interpolated shell string:

  ```ts
  execFile(
    env.MAESTRO_COMMAND,
    [
      'test',
      '--format', 'junit',
      '--output', path.join(runDir, 'junit.xml'),
      '--test-output-dir', runDir,
      resolvedFlowPath,
    ],
    { timeout: env.MAESTRO_TIMEOUT_MS, maxBuffer, cwd: workspaceAbs },
  );
  ```

  `--format junit --output <runDir>/junit.xml` writes the JUnit XML report into the run directory
  (JUnit alone is sufficient for the MVP). `--test-output-dir <runDir>` directs Maestro's own
  screenshots and artifacts into the same run directory.

- **Timeout / cleanup:** on `MAESTRO_TIMEOUT_MS` expiry or `AbortSignal`, kill the child process
  and clean up; surface a `Blocked` result, never a hung run.
- **Bounded output:** `maxBuffer` cap on stdout/stderr; truncated capture is written to the run
  directory and returned.
- **Exit handling:** non-zero exit → structured `result: 'Failed'` with captured output; success
  → `result: 'Passed'` referencing the JUnit report path (relative). Never reported as success
  unless Maestro completed successfully.
- **Injectable seam:** the spawn function and clock are injectable so tests exercise argv
  construction, timeout/kill, bounded output, and exit handling without a real `maestro` binary.

The tool returns only **relative** artifact paths (e.g. `artifacts/maestro/<runId>/junit.xml`).

## 7. Example flow (requirement 12)

`maestro/smoke/launch.yaml` ships as the single example — a minimal placeholder app launch with no
assertions on real elements:

```yaml
# Placeholder app id. Replace with your application's package before running.
appId: com.example.qaapp
---
- launchApp
```

## 8. Environment (requirement 11)

Five variables added to the existing Zod `envSchema` in `agent/src/config/env.ts`:

```dotenv
MAESTRO_ENABLED=false
MAESTRO_COMMAND=maestro
MAESTRO_WORKSPACE=../maestro
MAESTRO_ARTIFACT_DIR=../artifacts/maestro
MAESTRO_TIMEOUT_MS=120000
```

- `MAESTRO_ENABLED`: `z.enum(['true','false']).default('false')` — Chekku boots normally without
  Maestro installed.
- `MAESTRO_COMMAND`: non-empty string, default `maestro`.
- `MAESTRO_WORKSPACE` / `MAESTRO_ARTIFACT_DIR`: non-empty strings with the documented defaults.
- `MAESTRO_TIMEOUT_MS`: positive integer, default `120000`.

All five are validated by the schema and covered by `env.test.ts`.

**Absolute-path resolution.** `MAESTRO_WORKSPACE` and `MAESTRO_ARTIFACT_DIR` are resolved to
absolute paths **once** (memoized helper that resolves relative to the agent process cwd), so the
runner and path validator always compare absolute, real-resolved paths. The flow runner never
re-parses these per call.

> **Path note.** The Mastra CLI runs from the `agent/` workspace (see `docs/OPERATIONS.md`), so the
> default `MAESTRO_WORKSPACE=../maestro` resolves to `<repo-root>/maestro/` — exactly where the
> checked-in example flow ships. Likewise `MAESTRO_ARTIFACT_DIR=../artifacts/maestro` resolves to
> `<repo-root>/artifacts/maestro/`. Point both elsewhere to keep flows/artifacts outside the repo.

## 9. Agent response contract (requirement 13)

The agent instructions enforce this Markdown structure. The agent must **never** claim a test
passed unless Maestro completed successfully:

```text
Summary
- Result: Passed / Failed / Blocked
- App ID
- Device
- Scenario

Executed scenarios
1. Scenario — Result

Findings
- ID
- Severity
- Expected behaviour
- Actual behaviour
- Reproduction steps
- Evidence

Blockers
- Missing device, missing application, authentication requirement, or infrastructure problem
```

## 10. Client changes (requirement 10)

- `client/src/lib/types.ts`: add `QA_ANDROID_AGENT_ID = 'qa-android-agent'` and extend
  `RESERVED_AGENT_IDS`. (Also reflected in `client/src/lib/agents-helpers.ts` so the builder
  rejects the reserved id.)
- Catalog (`agent-catalog-page.tsx`): render the android agent with a distinct badge/glyph
  (separate from the browser `◎`).
- Chat (`chat-studio.tsx`): the Ask First / Full Access switch is shown **only for QA agents**
  (`qa-web-agent` or `qa-android-agent`); hidden for all others. It sends `browserAccess` for the
  web agent and `mobileAccess` for the android agent on the request context. Two separate
  persisted `localStorage` keys so the two agents keep independent modes. The existing tool
  approval UI (Approve/Decline) is reused unchanged.

## 11. Registration (requirement 9)

`agent/src/mastra/index.ts` adds `qaAndroidAgent` to the `agents: { ... }` map alongside
`mainAgent, pmAgent, qaWebAgent, socialMediaAgent`. The Maestro MCP client is **not** added to the
global `mcpServers` (that slot stays fixed to `garage`); it is bound privately to the android agent
through its own allowlisted `tools` resolver, matching the way `pm-agent` keeps its tools private.

## 12. Files

### New (agent)

- `agent/src/agents/qa-android-agent.ts`
- `agent/src/mastra/maestro/mcp-client.ts` — lazy, env-gated MCPClient factory + allowlist filter.
- `agent/src/mastra/maestro/flow-path.ts` — pure path resolver (absolute, real-path containment,
  regular-file check).
- `agent/src/mastra/maestro/run-flow.ts` — safe `execFile` runner + JUnit/artifact capture.
- `agent/src/mastra/maestro/paths.ts` — memoized absolute-path resolution for workspace/artifact.
- `agent/src/mastra/tools/run-maestro-flow.ts` — curated tool wrapping the runner
  (lives alongside `pm-report-tools.ts` / `send-email.ts`).

### Modified (agent)

- `agent/src/agents/context.ts` (+ `mobileAccess`).
- `agent/src/mastra/index.ts` (+ `qaAndroidAgent`).
- `agent/src/config/env.ts`, `agent/src/config/env.test.ts` (+ 5 `MAESTRO_*`).

### New (repo root)

- `maestro/smoke/launch.yaml` (example). (`maestro/regression/`, `maestro/shared/` created as
  needed; only the example flow ships.)

### Modified (client)

- `client/src/lib/types.ts`, `client/src/lib/agents-helpers.ts`.
- `client/src/components/agents/agent-catalog-page.tsx`.
- `client/src/components/chat/chat-studio.tsx`.
- `client/src/lib/ui-structure.test.ts`, `client/src/lib/agents-helpers.test.ts`.

### Modified (docs / config)

- `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `AGENTS.md`, `.env.example`,
  `agent/.env.example`, `.gitignore` (+ `artifacts/`, maestro run outputs).

## 13. Automated tests (requirement: Testing)

Vitest only. No new runner. Unit-level. Minimum coverage:

- Android agent registration: id, name, memory present, tool set, `maxSteps`.
- Maestro MCP configuration: env-gated construction, fixed command/args, allowlist filtering
  (keeps allowlisted tools, drops `run_flow_files` and unknown tools), no model/user input.
- `shouldApproveQaAndroidTool`: read-only never approves; granular tools honour `mobileAccess`;
  `maestro_run_flow` always approves; `run_maestro_flow` honours `mobileAccess`; defaults to
  gating when unset; harmless tools never gated.
- Request-context validation: `mobileAccess` schema; `browserAccess` unchanged.
- `resolveMaestroFlowPath`: accepts `{smoke, login}`; rejects absolute paths, `..`, backslashes,
  caller-supplied extensions, slashes in `flow`, non-allowlisted `suite`, symlink-escape,
  out-of-workspace containment, and non-regular files.
- `runMaestroFlow`: execFile receives an argv array (never a shell string) including the JUnit
  `--format`/`--output` and `--test-output-dir` args; `MAESTRO_TIMEOUT_MS` kills the child; bounded
  output truncation; non-zero exit yields `Failed`; missing file yields a fixed error; success
  references the relative JUnit path.
- Absolute-path resolution: workspace/artifact resolved once; memoized; real-path containment after
  symlinks.
- Env parsing: defaults (`MAESTRO_ENABLED=false`) + overrides; rejects bad `MAESTRO_ENABLED`;
  coerces `MAESTRO_TIMEOUT_MS` to a positive integer.
- Client badge + access-switch visibility (shown for both QA agents, hidden otherwise); reserved-id
  set includes `qa-android-agent`.
- Existing agents (`main`, `pm`, `qa-web`, `social`) remain unaffected — their ids, names, tools,
  and approval behaviour unchanged.

ExecFile/argv and timeout behaviour are tested through the injectable spawn seam + fake timers, so
no real `maestro` binary is required.

## 14. Manual acceptance verification

Automated tests are unit-level only. Before the PR is considered complete, the change must be
verified by hand on a real Android emulator or physical device on the same machine as Chekku:

1. `maestro`, `adb`, and an emulator/device are reachable; `adb devices` lists a device.
2. `MAESTRO_ENABLED=true` (and `MAESTRO_*` paths) set in `agent/.env`; agent server restarted.
3. `qa-android-agent` appears in the catalog with the Android badge.
4. In a chat: `maestro_list_devices` runs **without** approval and lists the device.
5. Ask-First mode: a granular action (e.g. `maestro_tap_on`) requests approval; Full Access runs
  without approval; `maestro_run_flow` (inline YAML) requests approval in **both** modes.
6. `run_maestro_flow` with `{ suite: 'smoke', flow: 'launch' }` runs the checked-in example,
  writes `artifacts/maestro/<runId>/junit.xml`, and returns a `Passed`/`Failed` result consistent
  with the actual run.
7. The agent's final response follows the §9 contract; it does **not** claim Passed unless Maestro
  succeeded.
8. Traversal rejection: a crafted `{ suite: '../secret', flow: 'x' }` (or backslash / absolute)
  input is rejected before any process spawns.

Manual acceptance results are recorded in the PR description (device, app id, pass/fail per step).

## 15. Completion gates

Before claiming done:

- `npm run check` passes.
- `npm run build` passes.
- `git diff --check` clean.
- All new targeted unit tests pass.
- §14 manual acceptance completed and recorded.

## 16. Known limitations

- Chekku, the Maestro CLI, ADB, and an Android emulator or physical device must be reachable on the
  same machine for any live run. The MVP performs no remote/device-farm execution.
- The agent degrades gracefully when Maestro is disabled/uninstalled (`MAESTRO_ENABLED=false`); it
  cannot drive a device in that state.
- Maestro Cloud is intentionally not exposed.
- Automated tests do not exercise a live device; §14 covers that manually.
