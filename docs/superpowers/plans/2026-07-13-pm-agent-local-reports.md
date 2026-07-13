# PM Agent Local Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in PM Agent to Chekku that analyzes, saves, lists, and views weekly reports.

**Architecture:** Share Chekku's existing request-context model resolver pattern, add focused filesystem report helpers and Mastra tools, then register a separate `pmAgent` alongside `mainAgent`.

**Tech Stack:** TypeScript, Mastra Agent/tools, Zod v3-compatible schemas, Node filesystem APIs, node:test.

## Global Constraints

- Do not change `main-agent` browser behavior.
- Do not add Garage/S3 dependency.
- Do not add server-side default model keys.
- Keep explicit `AgentConfig<string, ToolsInput, undefined, ProviderContext>` typing to avoid deep generic inference.

---

### Task 1: Shared Provider Resolver

**Files:**
- Create: `agent/src/mastra/agents/provider-context.ts`
- Modify: `agent/src/mastra/agents/main-agent.ts`

**Interfaces:**
- Produces `providerContextSchema`, `type ProviderContext`, `resolveProviderModel`.

- [ ] Extract provider context schema and model resolver from `main-agent.ts`.
- [ ] Update `main-agent.ts` imports without changing behavior.
- [ ] Run agent typecheck.

### Task 2: Local Report Store

**Files:**
- Create: `agent/src/mastra/pm-reports/store.ts`
- Create: `agent/src/mastra/pm-reports/store.test.ts`

**Interfaces:**
- Produces `savePmReport`, `listPmReports`, `getPmReport`, `parseRiskHeader`, and report metadata types.

- [ ] Add node:test coverage for save/list/view and invalid risk header.
- [ ] Implement local filesystem report storage under configurable base directory.
- [ ] Run `node --experimental-strip-types --test agent/src/mastra/pm-reports/store.test.ts`.

### Task 3: PM Report Tools

**Files:**
- Create: `agent/src/mastra/tools/pm-report-tools.ts`
- Create: `agent/src/mastra/tools/pm-report-tools.test.ts`

**Interfaces:**
- Produces `savePmReportTool`, `listPmReportsTool`, `viewPmReportTool`.

- [ ] Add direct tool tests with temp directory.
- [ ] Implement tools using `createTool`.
- [ ] Run tool tests.

### Task 4: PM Agent Registration

**Files:**
- Create: `agent/src/mastra/agents/pm-agent.ts`
- Modify: `agent/src/mastra/index.ts`

**Interfaces:**
- Produces `pmAgent` registered as `{ mainAgent, pmAgent }`.

- [ ] Add PM Agent with Markdown risk report instructions and save/list/view behavior.
- [ ] Register PM Agent in Mastra.
- [ ] Run typecheck.

### Task 5: Verification

- [ ] Run all new node:test files.
- [ ] Run `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck`.
- [ ] Run existing `npm run test:agents`.
