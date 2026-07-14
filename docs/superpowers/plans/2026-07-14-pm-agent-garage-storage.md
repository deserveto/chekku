# PM Agent Garage Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chekku PM Agent local filesystem reports with Garage S3-compatible object storage.

**Architecture:** PM report domain logic moves from filesystem paths to an object-store interface. Garage-specific S3 wiring lives in a lazy store module, and Mastra tools expose save/list/view operations to `pm-agent` only through Garage tool ids.

**Tech Stack:** TypeScript, Mastra tools, Zod 3.25.76, Vitest, `@aws-sdk/client-s3`, Garage S3-compatible API.

## Global Constraints

- Keep Garage credentials server-side in `agent/.env` or deployment secrets only.
- Do not add client-side Garage environment variables.
- Do not add custom PM report HTTP routes.
- Do not add local/Garage storage selector.
- Object layout must be `pm-reports/<reportId>/input.md`, `analysis.md`, and `metadata.json`.
- Tool ids must be `save_pm_report_to_garage`, `list_pm_reports_from_garage`, and `view_pm_report_from_garage`.

---

## File Structure

- `agent/package.json`: add `@aws-sdk/client-s3` dependency.
- `agent/src/config/env.ts`: parse optional Garage env vars.
- `agent/src/config/env.test.ts`: cover Garage env parsing.
- `agent/src/mastra/pm-reports/store.ts`: convert PM report persistence to object-store interface.
- `agent/src/mastra/pm-reports/store.test.ts`: update tests to in-memory object store.
- `agent/src/mastra/pm-reports/garage-store.ts`: add lazy Garage/S3 object store.
- `agent/src/mastra/pm-reports/garage-store.test.ts`: test config validation and body conversion behavior through public API where feasible.
- `agent/src/mastra/tools/pm-report-tools.ts`: replace local tools with Garage tools.
- `agent/src/mastra/tools/pm-report-tools.test.ts`: update save/list/view tool tests.
- `agent/src/agents/pm-agent.ts`: register Garage tools and update instructions.
- `agent/src/agents/__tests__/both-agents.test.ts`: assert Garage tools are attached.
- `agent/.env.example`, `README.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`: document Garage storage.

### Task 1: Garage Env And Dependency

**Files:**
- Modify: `agent/package.json`
- Modify: `agent/src/config/env.ts`
- Modify: `agent/src/config/env.test.ts`
- Modify: `agent/.env.example`

**Interfaces:**
- Produces `env.GARAGE_ENDPOINT`, `env.GARAGE_REGION`, `env.GARAGE_BUCKET`, `env.GARAGE_ACCESS_KEY_ID`, `env.GARAGE_SECRET_ACCESS_KEY` as strings defaulting to empty.

- [ ] Add dependency `@aws-sdk/client-s3` to `agent/package.json`.
- [ ] Add Garage env keys to `envSchema` with empty defaults.
- [ ] Add tests proving defaults are empty and valid Garage config is accepted.
- [ ] Add Garage placeholders to `agent/.env.example`.
- [ ] Run `npx vitest run agent/src/config/env.test.ts`.

### Task 2: Object-Store PM Report Domain

**Files:**
- Modify: `agent/src/mastra/pm-reports/store.ts`
- Modify: `agent/src/mastra/pm-reports/store.test.ts`

**Interfaces:**
- Produces `PmReportObjectStore`, `PmReportMetadata`, `savePmReport(input)`, `listPmReports(store)`, `getPmReport(store, reportId)`, `keysFor(reportId)`, `parseRiskHeader(markdown)`.

- [ ] Replace filesystem path fields with object key fields.
- [ ] Save input, analysis, and metadata through `store.putText()`.
- [ ] List metadata through `store.listText('pm-reports/')` and sort newest first.
- [ ] Read report objects through `store.getText()`.
- [ ] Update tests to use in-memory object store.
- [ ] Run `npx vitest run agent/src/mastra/pm-reports/store.test.ts`.

### Task 3: Lazy Garage Store

**Files:**
- Create: `agent/src/mastra/pm-reports/garage-store.ts`
- Create: `agent/src/mastra/pm-reports/garage-store.test.ts`

**Interfaces:**
- Produces `readGarageConfig(raw?)`, `createGarageReportStore(config?)`, `createLazyGarageReportStore()`.

- [ ] Implement required env validation with clear missing-config error.
- [ ] Implement S3 client with `forcePathStyle: true`.
- [ ] Implement `putText`, `getText`, and paginated `listText`.
- [ ] Ensure lazy store validates config only when used.
- [ ] Run `npx vitest run agent/src/mastra/pm-reports/garage-store.test.ts`.

### Task 4: Garage Tools And PM Agent Wiring

**Files:**
- Modify: `agent/src/mastra/tools/pm-report-tools.ts`
- Modify: `agent/src/mastra/tools/pm-report-tools.test.ts`
- Modify: `agent/src/agents/pm-agent.ts`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Produces `createSavePmReportToGarageTool`, `createListPmReportsFromGarageTool`, `createViewPmReportFromGarageTool`, and exported tool instances.

- [ ] Replace local tool ids with Garage tool ids.
- [ ] Use lazy Garage store by default and test `storeFactory` seams.
- [ ] Update PM Agent instructions for Garage save/list/view.
- [ ] Assert PM Agent has Garage tool ids and not local tool ids.
- [ ] Run `npx vitest run agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/__tests__/both-agents.test.ts`.

### Task 5: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Documents Garage env vars and PM Agent report storage behavior.

- [ ] Update docs for Garage env vars and storage behavior.
- [ ] Run `npm install --package-lock-only --workspace agent` if lockfile needs dependency update.
- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.

## Self-Review

- Spec coverage: all env, store, tools, agent wiring, tests, and docs requirements map to tasks above.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: object-store metadata field names match Aether: `inputObjectKey`, `analysisObjectKey`, `metadataObjectKey`.
