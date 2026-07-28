# Remove Tool Approval — Design Spec

**Date:** 2026-07-17
**Branch:** feat/qa-android-agent
**Status:** Approved

## Goal

Remove the "Ask First / Full Access" switch and the per-tool approval concept
entirely. Every agent — code-defined and stored/builder, current and future —
runs without per-tool approval. Browser and mobile actions execute directly.

## Background

Only two agents have `requireToolApproval` today:

- `qa-web-agent` gates `browser_click/type/select/press/dialog/drag` via the
  `browserAccess` request-context field (`shouldApproveQaWebTool`).
- `qa-android-agent` gates `maestro_run` + `run_maestro_flow` via the
  `mobileAccess` request-context field (`shouldApproveQaAndroidTool`).

Every other agent (`main`, `pm`, `social` incl. `send-email`, stored-agents,
builder agents) already runs without a tool-approval gate. The switch UI in
`chat-studio.tsx` is shown only for the two QA agents and persists
`browserAccess`/`mobileAccess` to localStorage.

Therefore "all agents Full Access" is a **pure deletion**: no new abstraction,
no replacement concept. Future agents inherit "no approval" by default because
nothing wires `requireToolApproval`.

## Scope expansion (tool-level `requireApproval`)

A repo-wide grep revealed two more `requireApproval: true` sites that surfaced
through the same chat approve/decline UI (so removing the UI broke their path
too), and the user confirmed removing them for a true "all-Full-Access" system:

- `agent/src/mastra/tools/garage-object-tools.ts` — `replace_text_object` and
  `delete_object` no longer set `requireApproval`. They run directly (the
  `destructiveHint` MCP annotations stay as accurate metadata).
- `agent/src/mastra/tools/send-email.ts` — `sendEmailTool` no longer sets
  `requireApproval`; outbound email runs directly.

With no `requireApproval` anywhere and no `requireToolApproval` on any agent,
no tool ever suspends, so the client approve/decline/resume path is fully dead
and removed.

## Deletion inventory

### Agent workspace

- `agent/src/agents/context.ts` — drop `browserAccess` and `mobileAccess` from
  `providerContextSchema`.
- `agent/src/agents/qa-web-agent.ts` — delete `QA_WEB_APPROVAL_BROWSER_TOOLS`,
  `shouldApproveQaWebTool`, the `requireToolApproval` block, and the
  "request approval before consequential actions" instruction sentence.
- `agent/src/agents/qa-android-agent.ts` — delete `READ_ONLY_TOOLS`,
  `MODE_GATED_TOOLS`, `shouldApproveQaAndroidTool`, and the
  `requireToolApproval` block.
- Tests: delete the classifier tests in `qa-web-agent.test.ts` and
  `qa-android-agent.test.ts` (whole files); drop the `browserAccess`/
  `mobileAccess` assertions in `context.test.ts` and `zod-compatibility.test.ts`.

### Client workspace

- `client/src/components/chat/chat-studio.tsx`:
  - Remove `BROWSER_ACCESS_KEY`/`MOBILE_ACCESS_KEY`, `browserMode`/`mobileMode`
    state, the localStorage effects, `isQaAgent`/`accessMode`/`setAccessMode`,
    and the `context.set('browserAccess'|'mobileAccess')` lines.
  - Remove the switch UI and the footer access-mode warning branch.
  - Remove `resumeApprovalGenerate`, `resolveApproval`, `ApprovalResumeResult`,
    and the approve/decline button rendering for suspended tool events (no tool
    suspends anymore → dead path).
- `client/src/lib/ui-structure.test.ts` — drop the access-switch assertions.

### Docs

- `AGENTS.md` — remove the `mobileAccess`/`browserAccess` invariant bullets and
  the approval-gating rules; note that no agent requires tool approval.
- `docs/ARCHITECTURE.md` — remove the approval-classifier description.
- `docs/OPERATIONS.md` — remove the Ask First / Full Access switch mention.

## Non-goals

- No replacement approval mechanism. No per-agent opt-in. No new request-context
  fields.
- Stored-agent / builder hydration is untouched — they never read these fields.

## Verification

- `npm run check` (typecheck ×3 + lint + tests) green with the classifier tests
  removed.
- `npm run build` green.
- `git diff --check` clean.
- Live: a QA task runs browser/mobile actions with no approval prompt and no
  switch present.
