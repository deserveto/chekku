# PM Agent Garage Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PM Agent report analysis, namespaced Garage persistence, report APIs/pages, and clickable chat links on top of approved generic Garage foundation.

**Architecture:** PM report semantics live in a typed repository and code-defined PM Agent tools, never generic Garage MCP. Both agent tools and server-only client report services bind root storage to fixed `pm-agent` namespace, while persisted metadata and public outputs retain relative report keys.

**Tech Stack:** TypeScript, Mastra Agent/Memory/tools, `@chekku/storage`, Next.js 16 App Router, React Markdown, Zod, Vitest.

## Global Constraints

- Start `feat/pm-agent-garage-reports` from approved `feat/generic-garage-mcp` tip.
- Local file changes, branches, and commits may proceed. Ask immediately before every push. Closing PRs, deleting branches, or rewriting published history requires explicit confirmation.
- PM tools remain code-defined on `pm-agent`; generic Garage MCP remains unchanged and contains no PM tool IDs.
- Bind all PM storage to fixed namespace `pm-agent`; never accept namespace from model, route, browser, or request identity.
- Persist and return relative `pm-reports/...` keys, never physical `agents/...` keys.
- Do not migrate or fall back to old global development objects.
- Browser code never contacts Garage directly.
- Report list `reportUrl` is presentation-only; save/view/persisted metadata remain unchanged.
- Follow TDD and keep commits local until the user approves a push.

---

### Task 1: Add Namespaced PM Report Repository

**Files:**
- Create: `storage/src/pm-reports.ts`
- Create: `storage/src/pm-reports.test.ts`
- Modify: `storage/src/index.ts`

**Interfaces:**
- Consumes: `ObjectStorage`, `createNamespacedObjectStorage()` from generic branch.
- Produces: `PM_REPORT_AGENT_ID`, `createPmReportStorage()`, report metadata/read APIs.

- [ ] **Step 1: Write failing repository tests**

Assert risk parsing, report ID validation, metadata consistency, metadata-last persistence, malformed metadata skipping, newest-first listing, safe read failures, and physical namespace behavior:

```ts
expect(PM_REPORT_AGENT_ID).toBe('pm-agent');
expect(rootKeys()).toContain(
  `agents/${Buffer.from('pm-agent').toString('base64url')}/pm-reports/${reportId}/metadata.json`,
);
expect(metadata.metadataObjectKey).toBe(`pm-reports/${reportId}/metadata.json`);
```

Seed another agent namespace and prove PM list/read cannot see it.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run storage/src/pm-reports.test.ts`

Expected: FAIL because PM repository is absent from generic branch.

- [ ] **Step 3: Implement repository**

Export:

```ts
export const PM_REPORT_AGENT_ID = 'pm-agent';
export const createPmReportStorage = (root: ObjectStorage): ObjectStorage =>
  createNamespacedObjectStorage(root, PM_REPORT_AGENT_ID);
```

Keep logical keys under `pm-reports/<reportId>/`. Validate rating/status agreement and metadata key ownership. Write input and analysis before metadata so partial saves do not list. Do not add migration fallback.

- [ ] **Step 4: Verify GREEN**

Run PM/storage tests and storage typecheck.

- [ ] **Step 5: Commit task**

Stage repository files and commit `feat(storage): add PM report repository`.

### Task 2: Add PM Agent And Report Tools

**Files:**
- Create: `agent/src/agents/pm-agent.ts`
- Create: `agent/src/mastra/tools/pm-report-tools.ts`
- Create: `agent/src/mastra/tools/pm-report-tools.test.ts`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts`
- Modify: `agent/src/mastra/index.ts`
- Modify: `agent/src/__tests__/agent-routes.test.ts`
- Modify: `agent/src/mastra/mcp/garage-mcp-server.test.ts`

**Interfaces:**
- Consumes: PM repository and `createPmReportStorage()`.
- Produces: `pmAgent`, save/list/view tools.

- [ ] **Step 1: Write failing tool tests**

Inject a root store, then assert every factory wraps it with PM namespace. Verify save/list/view behavior, strict schemas, list-only URL:

```ts
expect(listed.reports[0].reportUrl).toBe(`/reports/${encodeURIComponent(reportId)}`);
expect(saved).not.toHaveProperty('reportUrl');
expect(viewed).not.toHaveProperty('reportUrl');
expect(JSON.parse(storedMetadata)).not.toHaveProperty('reportUrl');
```

- [ ] **Step 2: Run tool tests and verify RED**

Run: `npx vitest run agent/src/mastra/tools/pm-report-tools.test.ts`

Expected: FAIL because PM tools are absent.

- [ ] **Step 3: Implement tools and PM Agent**

Tool option `storeFactory` returns root storage and is always wrapped by `createPmReportStorage()`, including tests. Configure PM Agent ID `pm-agent`, `memory: new Memory()`, and `maxSteps: 12`. Preserve exact risk template and require report links as `[<reportId>](<reportUrl>)`.

- [ ] **Step 4: Add composition separation tests**

Assert `pmAgent` registration and built-in identity/tools. Assert generic Garage MCP still exposes exactly five generic IDs and no PM IDs.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/mcp/garage-mcp-server.test.ts agent/src/__tests__/agent-routes.test.ts
npm run typecheck --workspace agent
```

- [ ] **Step 6: Commit task**

Stage listed agent files and commit `feat(agent): add Garage-backed PM reports`.

### Task 3: Add Authenticated Report Service And APIs

**Files:**
- Create: `client/src/server/pm-reports.ts`
- Create: `client/src/server/pm-reports.test.ts`
- Create: `client/src/app/api/storage/pm-reports/route.ts`
- Create: `client/src/app/api/storage/pm-reports/[reportId]/route.ts`
- Modify: `client/package.json`
- Modify: `client/tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: PM repository and fixed namespace binding.
- Produces: authenticated list/read service and safe GET endpoints.

- [ ] **Step 1: Write failing service and route tests**

Cover missing identity before storage, invalid report ID before storage, successful list/read, 403/400/404/503 mappings, unknown safe 500, and no raw provider message leakage. Assert injected root stores are namespaced.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run client/src/server/pm-reports.test.ts`

Expected: FAIL because service/routes are absent.

- [ ] **Step 3: Implement server-only boundary**

Use `server-only`, `getServerUserId()`, strict report ID validation, and `createPmReportStorage(rootStoreFactory())`. Return safe `PmReportServiceError` codes: `forbidden`, `invalid-report-id`, `not-found`, `storage-unavailable`. API routes expose `{ reports }` or report detail and safe structured errors.

- [ ] **Step 4: Verify GREEN**

Run service tests, client typecheck, and lint.

- [ ] **Step 5: Commit task**

Stage listed files and commit `feat(client): expose PM report APIs`.

### Task 4: Add Report Pages And Clickable Chat Links

**Files:**
- Create: `client/src/app/reports/page.tsx`
- Create: `client/src/app/reports/[reportId]/page.tsx`
- Create: `client/src/components/markdown-message.test.ts`
- Modify: `client/src/components/studio/studio-nav.tsx`
- Modify: `client/src/app/studio.css`
- Modify: `client/src/lib/ui-structure.test.ts`
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/agents-helpers.ts`
- Modify: `client/src/lib/agents-helpers.test.ts`

**Interfaces:**
- Consumes: report service from Task 3 and tool-provided relative URLs.
- Produces: `/reports`, `/reports/[reportId]`, protected built-in PM ID.

- [ ] **Step 1: Write failing UI structure and identity tests**

Assert report navigation, encoded detail links, list empty/error states, detail ordering (analysis, metadata, input), PM built-in ID reservation, and Markdown rendering:

```ts
const html = renderToStaticMarkup(
  createElement(MarkdownMessage, { content: '[report](/reports/pmr_test)' }),
);
expect(html).toContain('href="/reports/pmr_test"');
expect(html).toContain('target="_blank"');
expect(html).toContain('rel="noreferrer"');
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run client/src/lib/ui-structure.test.ts client/src/lib/agents-helpers.test.ts client/src/components/markdown-message.test.ts
```

- [ ] **Step 3: Implement pages, navigation, styles, and ID protection**

Use server components and server-only report service. Keep browser free of Garage imports. Add `PM_AGENT_ID = 'pm-agent'` to both canonical protected-ID paths. Preserve existing visual language and responsive report layouts.

- [ ] **Step 4: Verify GREEN**

Run focused tests, client typecheck, and lint.

- [ ] **Step 5: Commit task**

Stage listed UI files and commit `feat(client): browse PM reports`.

### Task 5: Document PM Layer And Verify Branch

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Documents PM layer without changing generic Garage MCP contract.

- [ ] **Step 1: Update documentation**

Document PM Agent, fixed `pm-agent` namespace, relative metadata keys, code-defined PM tools, APIs/pages, report links, identity seam, no migration, and generic MCP separation.

- [ ] **Step 2: Run full verification**

```bash
npm ci
npm run check
npm run build
git diff --check
git status --short
```

Expected: PASS; status contains only intended PM branch files.

- [ ] **Step 3: Review branch boundaries**

Confirm generic MCP implementation unchanged, exact five generic tools remain, PM tools appear only on PM Agent, physical prefixes never leak, report links render, and no local state/secrets are staged.

- [ ] **Step 4: Commit documentation**

Show complete diff and evidence, then commit docs with `docs: document PM Garage reports`.

- [ ] **Step 5: Stop before remote operations**

Ask separately before push and stacked PR creation. After generic PR merges, ask again before rebase/retarget. Ask again before closing old PRs or deleting old remote branches.
