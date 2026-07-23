# PM Competitive Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PM Agent first-class weekly and competitive-analysis skills, bounded six-to-eight-product web research, separate Garage persistence, and grouped weekly/competitive report browsing.

**Architecture:** PM Agent loads inline Mastra skills and directly orchestrates existing `search_web` and `read_web_page` tools. New PM-only competitive report tools validate the deterministic completion boundary and call a separate `@chekku/storage` repository under fixed `pm-agent` namespace. Next.js adds authenticated competitive list/detail APIs and pages while preserving weekly report IDs, APIs, and detail URLs.

**Tech Stack:** TypeScript 6 strict mode, Mastra 1.50 inline skills and tools, Zod 3.25.76, Vitest, Next.js 16 App Router, React 19, shared `@chekku/storage`, Garage/S3.

## Global Constraints

- Work only in `C:\Users\diazh\OneDrive\文档\MAGANG\chekku\.worktrees\pm-competitive-analysis` on `feat/pm-competitive-analysis`; never rebase from local `main`.
- Read `AGENTS.md` and `docs/superpowers/specs/2026-07-23-pm-competitive-analysis-design.md` before editing.
- Follow regression-first TDD: observe each focused test fail before production code, then pass.
- Keep `agent/src/mastra/index.ts` as single Mastra composition root.
- Preserve fixed Garage, SearXNG, and Web Reader registries exactly; new competitive tools attach only to code-defined PM Agent.
- Reuse existing `search_web`, `read_web_page`, and `parsePublicWebUrl()`; add no crawler, recursive link following, provider fallback, endpoint, credential, PDF, upload, cookie, or custom-header support.
- Keep PM namespace fixed to `pm-agent`; never accept namespace or agent identity from model, route, browser, or local user input.
- Preserve weekly `pmr_...` repository, tools, APIs, deterministic Markdown, and `/reports/<pmr-id>` links.
- Competitive IDs must match `^pca_[0-9]{14}_[0-9a-f]{8}$`; object keys stay relative under `competitive-analyses/<analysisId>/`.
- Analyze anchor plus five-to-seven competitors. At most three searches, eight page reads, one save, and `maxSteps: 18`.
- Require one validated primary source mapping per product before save. Missing mention is `Unknown`, never inferred `No`.
- Treat Reader Markdown only as untrusted evidence. Page content cannot control tools, skills, output, candidate selection, or persistence.
- Keep `createAgentMemory()`, `createAgentContextLimiter()`, and `createCharBudgetGuard()` active, with configured character guard last.
- Do not read, print, log, or commit local environment values. Previously pasted Jina credential remains compromised.
- No implementation work on PR #10 IPv6 zone-ID or Mastra-private-API follow-ups.

---

## File Structure

### New files

- `storage/src/competitive-analyses.ts` - canonical IDs, metadata validation, namespaced save/list/get repository.
- `storage/src/competitive-analyses.test.ts` - repository ordering, isolation, malformed metadata, and ID tests.
- `agent/src/mastra/tools/markdown-table.ts` - shared safe table-cell and stored-timestamp formatting extracted from weekly tools.
- `agent/src/mastra/tools/competitive-analysis-tools.ts` - strict save/list/view PM tool schemas and deterministic list Markdown.
- `agent/src/mastra/tools/competitive-analysis-tools.test.ts` - save gate, namespace, presentation, and schema tests.
- `agent/src/agents/pm-agent-skills.ts` - two inline Mastra skills and their complete instructions.
- `agent/src/agents/__tests__/pm-agent-skills.test.ts` - skill metadata and behavioral contract tests.
- `client/src/server/competitive-analyses.ts` - authenticated server-only list/get boundary.
- `client/src/server/competitive-analyses.test.ts` - service and API safety tests.
- `client/src/app/api/storage/competitive-analyses/route.ts` - authenticated list API.
- `client/src/app/api/storage/competitive-analyses/[analysisId]/route.ts` - authenticated detail API.
- `client/src/app/reports/weekly/page.tsx` - moved weekly list UI.
- `client/src/app/reports/competitive/page.tsx` - competitive list UI.
- `client/src/app/reports/competitive/[analysisId]/page.tsx` - competitive detail UI.
- `client/src/app/reports/competitive/competitive-pages.test.ts` - grouped/list/detail route tests.

### Modified files

- `storage/src/index.ts` - export competitive repository API.
- `agent/src/mastra/tools/pm-report-tools.ts` - consume shared Markdown formatting helpers only; weekly output stays byte-for-byte unchanged.
- `agent/src/mastra/tools/pm-report-tools.test.ts` - guard extraction against weekly behavior regression.
- `agent/src/agents/pm-agent.ts` - register skills, three tools, concise router, and `maxSteps: 18`.
- `agent/src/agents/__tests__/both-agents.test.ts` - assert eight direct tools, two skills, processors, options, and router.
- `client/src/app/reports/page.tsx` - replace weekly list with grouped landing.
- `client/src/app/reports/reports-pages.test.ts` - test landing and moved weekly list while retaining weekly detail tests.
- `client/src/components/studio/studio-nav.test.ts` - nested Reports active-state coverage.
- `client/src/lib/ui-structure.test.ts` - new route source and server-boundary assertions.
- `client/src/app/studio.css` - report-choice cards and responsive one-column rule.
- `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` - public and operational contracts.

---

### Task 1: Competitive Analysis Storage Repository

**Files:**
- Create: `storage/src/competitive-analyses.ts`
- Create: `storage/src/competitive-analyses.test.ts`
- Modify: `storage/src/index.ts`

**Interfaces:**
- Consumes: `ObjectStorage`, `createNamespacedObjectStorage`, `PM_REPORT_AGENT_ID`, and `parsePmReportTimestamp`.
- Produces: `CompetitiveAnalysisMetadata`, `SaveCompetitiveAnalysisInput`, `CompetitiveAnalysisReadResult`, `createCompetitiveAnalysisStorage`, `createCompetitiveAnalysisId`, `competitiveAnalysisKeysFor`, `saveCompetitiveAnalysis`, `listCompetitiveAnalyses`, and `getCompetitiveAnalysis`.

- [ ] **Step 1: Write repository tests for IDs, writes, namespace, and round trip**

Create a memory `ObjectStorage` matching `storage/src/pm-reports.test.ts`, then add these concrete cases:

```ts
const analysisId = 'pca_20260723120000_deadbeef';
const input = {
  requestMarkdown: '/competitive-analysis GPT vs Claude',
  analysisMarkdown: '# Competitive Analysis: GPT',
  anchorProduct: 'GPT',
  market: 'General AI assistants',
  competitorNames: ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'],
  sourceCount: 6,
};

expect(competitiveAnalysisKeysFor(analysisId)).toEqual({
  requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
  analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
  metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
});

const metadata = await saveCompetitiveAnalysis({
  store: createCompetitiveAnalysisStorage(storage),
  ...input,
  analysisId,
  now: () => new Date('2026-07-23T12:00:00.000Z'),
});
expect(metadata).toMatchObject({
  analysisId,
  createdAt: '2026-07-23T12:00:00.000Z',
  anchorProduct: 'GPT',
  competitorNames: input.competitorNames,
  productCount: 6,
  sourceCount: 6,
});
expect(writes.map(({ key }) => key)).toEqual([
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/request.md`,
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/analysis.md`,
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/metadata.json`,
]);
await expect(getCompetitiveAnalysis(
  createCompetitiveAnalysisStorage(storage),
  analysisId,
)).resolves.toMatchObject({ analysisId, requestMarkdown: input.requestMarkdown });
```

Also test metadata-last visibility, partial-write failures, cross-agent isolation, newest-first ordering, truncated list rejection, malformed JSON/extra-field projection, wrong relative keys, invalid IDs, invalid timestamps retaining source order, anchor/competitor duplication, 4 and 8 competitors, source-count mismatch, 257-byte names, 513-byte market, and blank Markdown.

- [ ] **Step 2: Run repository tests and observe missing-module failure**

Run: `npx vitest run storage/src/competitive-analyses.test.ts`

Expected: FAIL because `./competitive-analyses.ts` does not exist.

- [ ] **Step 3: Implement strict repository**

Implement these exact public shapes:

```ts
export interface CompetitiveAnalysisMetadata {
  analysisId: string;
  createdAt: string;
  anchorProduct: string;
  market?: string;
  competitorNames: string[];
  productCount: number;
  sourceCount: number;
  requestObjectKey: string;
  analysisObjectKey: string;
  metadataObjectKey: string;
}

export interface SaveCompetitiveAnalysisInput {
  store: ObjectStorage;
  requestMarkdown: string;
  analysisMarkdown: string;
  anchorProduct: string;
  market?: string;
  competitorNames: string[];
  sourceCount: number;
  analysisId?: string;
  now?: () => Date;
}

export interface CompetitiveAnalysisReadResult {
  analysisId: string;
  requestMarkdown: string;
  analysisMarkdown: string;
  metadata: CompetitiveAnalysisMetadata;
}

const ANALYSIS_ID_RE = /^pca_[0-9]{14}_[0-9a-f]{8}$/;
export const createCompetitiveAnalysisStorage = (root: ObjectStorage): ObjectStorage =>
  createNamespacedObjectStorage(root, PM_REPORT_AGENT_ID);
```

Use `Buffer.byteLength(value, 'utf8')` for 256-byte names, 512-byte optional market, and 262,144-byte Markdown. Trim names and market before persistence, enforce case-insensitive product uniqueness, competitor count 5-7, and `sourceCount === competitorNames.length + 1`. Generate IDs with UTC 14-digit timestamp plus `randomBytes(4).toString('hex')`. Save request, analysis, then metadata using `createText`. Parse stored metadata as unknown, project only approved fields, verify exact derived keys/counts, skip malformed list entries, reject truncated listing, sort with `parsePmReportTimestamp`, and parallel-read detail objects.

Add named exports to `storage/src/index.ts` without changing weekly exports.

- [ ] **Step 4: Run repository and storage regression tests**

Run: `npx vitest run storage/src/competitive-analyses.test.ts storage/src/pm-reports.test.ts storage/src/namespaced-objects.test.ts`

Expected: all files PASS.

- [ ] **Step 5: Typecheck storage**

Run: `npm run typecheck --workspace @chekku/storage`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit repository slice**

```bash
git add storage/src/competitive-analyses.ts storage/src/competitive-analyses.test.ts storage/src/index.ts
git commit -m "feat(storage): add competitive analyses"
```

---

### Task 2: PM Competitive Report Tools

**Files:**
- Create: `agent/src/mastra/tools/markdown-table.ts`
- Create: `agent/src/mastra/tools/competitive-analysis-tools.ts`
- Create: `agent/src/mastra/tools/competitive-analysis-tools.test.ts`
- Modify: `agent/src/mastra/tools/pm-report-tools.ts`
- Modify: `agent/src/mastra/tools/pm-report-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 repository exports and existing `parsePublicWebUrl(value): URL`.
- Produces: `formatCompetitiveAnalysesMarkdown`, `createSaveCompetitiveAnalysisToGarageTool`, `createListCompetitiveAnalysesFromGarageTool`, `createViewCompetitiveAnalysisFromGarageTool`, and their three singleton PM tool exports.

- [ ] **Step 1: Write failing tests for save gate and deterministic presentation**

Add tests using a memory root store. Core accepted input:

```ts
const saveInput = {
  requestMarkdown: '/competitive-analysis GPT vs Claude',
  analysisMarkdown: [
    '# Competitive Analysis: GPT',
    '## Executive Summary',
    'GPT leads the compared set in the evidenced focus area.',
    '## Scope and Competitor Selection',
    'Anchor plus five competitors.',
    '## Product Profiles',
    '### GPT',
    'Primary source: https://openai.com/chatgpt/',
    '## Feature Matrix',
    '| Feature | GPT |',
    '| --- | --- |',
    '| Chat | [Yes](https://openai.com/chatgpt/) |',
    '## Gaps and Opportunities',
    'Evidence-backed opportunity.',
    '## Risks and Confidence',
    'Public evidence may change.',
    '## Recommendations',
    '1. Validate the highest-value gap.',
    '## Sources',
    '- GPT: https://openai.com/chatgpt/',
  ].join('\n\n'),
  anchorProduct: ' GPT ',
  market: ' AI assistants ',
  competitorNames: ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'],
  sources: [
    { productName: 'GPT', url: 'https://openai.com/chatgpt/' },
    { productName: 'Claude', url: 'https://www.anthropic.com/claude' },
    { productName: 'Gemini', url: 'https://gemini.google.com/' },
    { productName: 'Copilot', url: 'https://www.microsoft.com/copilot' },
    { productName: 'Perplexity', url: 'https://www.perplexity.ai/' },
    { productName: 'Meta AI', url: 'https://www.meta.ai/' },
  ],
};

const saved = await saveTool.execute?.(saveInput, {} as never);
expect(saved).toMatchObject({
  anchorProduct: 'GPT',
  market: 'AI assistants',
  productCount: 6,
  sourceCount: 6,
});
```

Reject strict-schema extras, blank/oversized Markdown, 4 or 8 competitors, duplicate products case-insensitively, source name mismatch, missing/extra/duplicate source mappings, duplicate normalized URLs, private/local/non-HTTP URLs, and URLs over 2,048 bytes before storage access.

Assert list Markdown exactly:

```text
| Analysis | Created | Anchor | Competitors | Sources |
| --- | --- | --- | ---: | ---: |
| [pca_20260723120000_deadbeef](/reports/competitive/pca_20260723120000_deadbeef) | 2026-07-23 12:00 UTC | GPT | 5 | 6 |
```

Assert exact empty text `No saved competitive analyses found.`, hostile anchor escaping, URL-encoded relative links, newest-first rows, and `analysisUrl`/`analysesMarkdown` absent from save, view, metadata, and stored JSON.

- [ ] **Step 2: Run tool tests and observe missing-module failure**

Run: `npx vitest run agent/src/mastra/tools/competitive-analysis-tools.test.ts`

Expected: FAIL because `competitive-analysis-tools.ts` does not exist.

- [ ] **Step 3: Extract shared safe table formatting**

Move weekly private `escapeMarkdownCell` and timestamp formatting into:

```ts
export function escapeMarkdownTableCell(value: string): string;
export function formatStoredCreatedAt(createdAt: string): string;
```

Keep current control-character escaping, zero-width Markdown breaks, strict RFC3339 parsing through `parsePmReportTimestamp`, and invalid timestamp preservation unchanged. Update `pm-report-tools.ts` to import these functions. Do not alter `formatPmReportsMarkdown()` output.

- [ ] **Step 4: Implement strict competitive tool schemas and factories**

Implement:

```ts
export interface CompetitiveAnalysisToolOptions {
  storeFactory?: () => ObjectStorage;
  now?: () => Date;
}

export function formatCompetitiveAnalysesMarkdown(
  analyses: readonly (CompetitiveAnalysisMetadata & { analysisUrl: string })[],
): string;

export function createSaveCompetitiveAnalysisToGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
);
export function createListCompetitiveAnalysesFromGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
);
export function createViewCompetitiveAnalysisFromGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
);

export const saveCompetitiveAnalysisToGarageTool = createSaveCompetitiveAnalysisToGarageTool();
export const listCompetitiveAnalysesFromGarageTool = createListCompetitiveAnalysesFromGarageTool();
export const viewCompetitiveAnalysisFromGarageTool = createViewCompetitiveAnalysisFromGarageTool();
```

Use strict Zod schemas. Validate byte limits with refinements. Normalize every source URL through `parsePublicWebUrl(url).href`. Trim product names and match source coverage case-insensitively while retaining canonical trimmed product spelling. Pass only derived `sourceCount` to Task 1 repository. Wrap every injected root store with `createCompetitiveAnalysisStorage()` and call `ensureReady?.()` before access. Tool IDs must exactly match spec.

- [ ] **Step 5: Run focused tool and URL tests**

Run: `npx vitest run agent/src/mastra/tools/competitive-analysis-tools.test.ts agent/src/mastra/tools/pm-report-tools.test.ts agent/src/mastra/web-reader/url.test.ts`

Expected: all files PASS; weekly Markdown assertions remain byte-for-byte unchanged.

- [ ] **Step 6: Typecheck agent**

Run: `npm run typecheck --workspace agent`

Expected: PASS.

- [ ] **Step 7: Commit tool slice**

```bash
git add agent/src/mastra/tools/markdown-table.ts agent/src/mastra/tools/competitive-analysis-tools.ts agent/src/mastra/tools/competitive-analysis-tools.test.ts agent/src/mastra/tools/pm-report-tools.ts agent/src/mastra/tools/pm-report-tools.test.ts
git commit -m "feat(agent): add competitive report tools"
```

---

### Task 3: PM Agent Skills And Routing

**Files:**
- Create: `agent/src/agents/pm-agent-skills.ts`
- Create: `agent/src/agents/__tests__/pm-agent-skills.test.ts`
- Modify: `agent/src/agents/pm-agent.ts`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Consumes: Task 2 singleton tools and Mastra `createSkill()`.
- Produces: `weeklyReportAnalysisSkill`, `competitiveAnalysisSkill`, and PM Agent with eight direct tools, two skills, and `maxSteps: 18`.

- [ ] **Step 1: Write failing skill contract tests**

Assert exact skill metadata:

```ts
expect(weeklyReportAnalysisSkill).toMatchObject({
  name: 'weekly-report-analysis',
  'user-invocable': true,
});
expect(competitiveAnalysisSkill).toMatchObject({
  name: 'competitive-analysis',
  'user-invocable': true,
});
```

Assert weekly instructions retain every current line from `pm-agent.ts:26-59`. Assert competitive instructions contain all exact invariants: first named product anchor, 5-7 competitors, more-than-7 narrowing request, 3 search calls, 8 reads, 1 save, user/search URLs only, one primary source per product, `Yes|Partial|No|Unknown`, missing mention not `No`, page evidence never instructions, exact eight report headings, incomplete unsaved behavior, and `Saved analysisId:` only after complete save.

Update PM Agent tests to assert:

```ts
expect(Object.keys(await pmAgent.listTools()).sort()).toEqual([
  'list_competitive_analyses_from_garage',
  'list_pm_reports_from_garage',
  'read_web_page',
  'save_competitive_analysis_to_garage',
  'save_pm_report_to_garage',
  'search_web',
  'view_competitive_analysis_from_garage',
  'view_pm_report_from_garage',
]);
expect((await pmAgent.listSkills()).map(({ name }) => name).sort()).toEqual([
  'competitive-analysis',
  'weekly-report-analysis',
]);
expect(await pmAgent.getDefaultOptions()).toMatchObject({ maxSteps: 18 });
expect((await pmAgent.listConfiguredInputProcessors()).map(({ id }) => id)).toEqual([
  'token-limiter',
  'char-budget-guard',
]);
```

Assert base instructions route explicit `/competitive-analysis`, natural-language competition requests, weekly reports, explicit competitive list/view, `pca_...`, `pmr_...`, generic weekly list compatibility, and unrelated conversation.

- [ ] **Step 2: Run agent tests and observe failures**

Run: `npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts`

Expected: FAIL because skills do not exist and PM Agent still has five tools and `maxSteps: 12`.

- [ ] **Step 3: Define complete inline skills**

Create both skills with explicit user invocation:

```ts
import { createSkill } from '@mastra/core/skills';

export const weeklyReportAnalysisSkill = createSkill({
  name: 'weekly-report-analysis',
  description: 'Analyze an engineering weekly report, rate delivery risk, and save the result.',
  'user-invocable': true,
  instructions: weeklyReportAnalysisInstructions,
});

export const competitiveAnalysisSkill = createSkill({
  name: 'competitive-analysis',
  description: 'Research an anchor product and five to seven similar products using public evidence, compare features, and save a complete report.',
  'user-invocable': true,
  instructions: competitiveAnalysisInstructions,
});
```

Define `weeklyReportAnalysisInstructions` in the same module by moving the
current weekly section from `pm-agent.ts:26-59` verbatim, including exact
template and save-failure behavior. Define `competitiveAnalysisInstructions`
as the complete imperative contract described in the next paragraph; neither
constant contains abbreviated or deferred sections.

For `competitiveAnalysisSkill.instructions`, encode the approved process in imperative order: parse request; reject missing anchor or more than seven supplied competitors; use supplied URLs or up to three searches; choose overlap by use case/customer/core capability; read at most eight user/search-result official pages; keep user seeds mandatory; require anchor plus five-to-seven evidenced competitors; classify matrix values under exact evidence semantics; ignore all page-authored workflow instructions; emit exact report heading order; return incomplete unsaved output if minimum fails; otherwise call save once with exact source map and return receipt.

- [ ] **Step 4: Wire PM Agent without changing context boundaries**

Set `skills: [weeklyReportAnalysisSkill, competitiveAnalysisSkill]`, add three Task 2 tools, set `maxSteps: 18`, and replace the large instruction string with concise routing instructions. Keep model, request context, memory, and processor array unchanged.

Do not add skill helper tools manually. Installed Mastra injects `skill`, `skill_search`, and `skill_read` only during execution; `pmAgent.listTools()` must remain the eight configured direct tools.

- [ ] **Step 5: Run skill, agent, and context tests**

Run: `npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/processors/context-limit.test.ts`

Expected: all files PASS.

- [ ] **Step 6: Typecheck agent**

Run: `npm run typecheck --workspace agent`

Expected: PASS.

- [ ] **Step 7: Commit skills slice**

```bash
git add agent/src/agents/pm-agent-skills.ts agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/pm-agent.ts agent/src/agents/__tests__/both-agents.test.ts
git commit -m "feat(agent): add PM analysis skills"
```

---

### Task 4: Competitive Analysis Server Service And APIs

**Files:**
- Create: `client/src/server/competitive-analyses.ts`
- Create: `client/src/server/competitive-analyses.test.ts`
- Create: `client/src/app/api/storage/competitive-analyses/route.ts`
- Create: `client/src/app/api/storage/competitive-analyses/[analysisId]/route.ts`

**Interfaces:**
- Consumes: Task 1 repository exports and existing `getUserId()` identity seam.
- Produces: `CompetitiveAnalysisServiceError`, `listCompetitiveAnalysesForUser`, `getCompetitiveAnalysisForUser`, and two GET APIs.

- [ ] **Step 1: Write failing service and API tests**

Use the dependency-injection pattern from `client/src/server/pm-reports.test.ts`. Test missing identity before root-store creation, malformed IDs before storage, PM namespace mapping, list/detail success, hostile metadata projection, not-found mapping, all other `ObjectStorageError` codes to safe 503, and unknown failures to safe 500.

Expected service errors:

```ts
{ code: 'forbidden', status: 403, message: 'Authentication is required.' }
{ code: 'invalid-analysis-id', status: 400, message: 'Invalid analysis id.' }
{ code: 'not-found', status: 404, message: 'Competitive analysis not found.' }
{ code: 'storage-unavailable', status: 503, message: 'Competitive analysis storage is unavailable.' }
```

Expected API bodies use `{ error: { code, message } }`; list success is `{ analyses }`; detail success is raw `CompetitiveAnalysisReadResult`; unknown messages are `Could not load competitive analyses.` and `Could not load competitive analysis.`.

- [ ] **Step 2: Run tests and observe missing-module failure**

Run: `npx vitest run client/src/server/competitive-analyses.test.ts`

Expected: FAIL because service and routes do not exist.

- [ ] **Step 3: Implement server-only service**

Start with `import 'server-only';`. Define:

```ts
const ANALYSIS_ID_RE = /^pca_[0-9]{14}_[0-9a-f]{8}$/;

export type CompetitiveAnalysisServiceErrorCode =
  | 'forbidden'
  | 'invalid-analysis-id'
  | 'not-found'
  | 'storage-unavailable';

export interface CompetitiveAnalysisServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  listAnalyses?: (store: ObjectStorage) => Promise<CompetitiveAnalysisMetadata[]>;
  getAnalysis?: (store: ObjectStorage, analysisId: string) => Promise<CompetitiveAnalysisReadResult>;
}

export async function listCompetitiveAnalysesForUser(
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<CompetitiveAnalysisMetadata[]>;

export async function getCompetitiveAnalysisForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<CompetitiveAnalysisReadResult>;
```

Require identity first, validate detail ID second, create `createCompetitiveAnalysisStorage(rootStoreFactory())` only after both checks, and map only fixed errors.

- [ ] **Step 4: Implement two GET routes**

Mirror PM routes with competitive service names and exact safe unknown messages. Detail params type is `Promise<{ analysisId: string }>`.

- [ ] **Step 5: Run service/API tests and client typecheck**

Run: `npx vitest run client/src/server/competitive-analyses.test.ts`

Expected: PASS.

Run: `npm run typecheck --workspace client`

Expected: PASS.

- [ ] **Step 6: Commit server slice**

```bash
git add client/src/server/competitive-analyses.ts client/src/server/competitive-analyses.test.ts client/src/app/api/storage/competitive-analyses/route.ts client/src/app/api/storage/competitive-analyses/[analysisId]/route.ts
git commit -m "feat(client): add competitive report APIs"
```

---

### Task 5: Grouped Report UI

**Files:**
- Modify: `client/src/app/reports/page.tsx`
- Create: `client/src/app/reports/weekly/page.tsx`
- Create: `client/src/app/reports/competitive/page.tsx`
- Create: `client/src/app/reports/competitive/[analysisId]/page.tsx`
- Modify: `client/src/app/reports/reports-pages.test.ts`
- Create: `client/src/app/reports/competitive/competitive-pages.test.ts`
- Modify: `client/src/components/studio/studio-nav.test.ts`
- Modify: `client/src/lib/ui-structure.test.ts`
- Modify: `client/src/app/studio.css`

**Interfaces:**
- Consumes: Task 4 server service and existing weekly service/Markdown renderer.
- Produces: grouped `/reports`, weekly list, competitive list/detail, and preserved weekly detail URL.

- [ ] **Step 1: Write failing page and route-structure tests**

Assert landing contains links `/reports/weekly` and `/reports/competitive` with headings `Weekly Reports` and `Competitive Analyses`. Import weekly list from `./weekly/page` and retain existing table expectations with `aria-label="Saved PM reports"` and encoded `/reports/<pmr-id>` detail links.

For competitive list, mock Task 4 service and assert:

```ts
expect(markup).toContain('aria-label="Saved competitive analyses"');
expect(markup).toContain('/reports/competitive/pca_20260723120000_deadbeef');
expect(markup).toContain('<td>GPT</td>');
expect(markup).toContain('<td>5</td>');
expect(markup).toContain('<td>6</td>');
```

Test exact empty/error states. Detail tests must call `notFound()` for `invalid-analysis-id` and `not-found`, retain safe 403/503 unavailable page, and verify heading order `Analysis`, `Metadata`, `Original request`.

Update static structure tests to prove browser pages import only server services, never `@chekku/storage`; sidebar Reports remains active for `/reports/competitive/<id>`; all list tables use focusable region wrapper; competitive detail uses `MarkdownMessage`.

- [ ] **Step 2: Run page tests and observe route failures**

Run: `npx vitest run client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts client/src/components/studio/studio-nav.test.ts client/src/lib/ui-structure.test.ts`

Expected: FAIL because grouped, weekly, and competitive pages do not exist yet.

- [ ] **Step 3: Move weekly list without changing behavior**

Move current `client/src/app/reports/page.tsx` list implementation to `client/src/app/reports/weekly/page.tsx`. Keep `dynamic = 'force-dynamic'`, error handling, table columns, timestamp formatting, accessibility attributes, and links to `/reports/${encodeURIComponent(report.reportId)}` unchanged. Keep `client/src/app/reports/[reportId]/page.tsx` unchanged.

- [ ] **Step 4: Implement grouped landing**

Replace `/reports/page.tsx` with server-rendered shell and two report-choice links:

```tsx
<section className="studio-section">
  <div className="studio-report-choice-grid">
    <Link className="studio-report-choice studio-panel" href="/reports/weekly">
      <p className="studio-eyebrow">Risk review</p>
      <h2>Weekly Reports</h2>
      <p>Review saved engineering weekly analyses and risk ratings.</p>
    </Link>
    <Link className="studio-report-choice studio-panel" href="/reports/competitive">
      <p className="studio-eyebrow">Market research</p>
      <h2>Competitive Analyses</h2>
      <p>Review saved product comparisons, feature matrices, and recommendations.</p>
    </Link>
  </div>
</section>
```

Use existing `StudioNav` and local server identity for `resourceId`.

- [ ] **Step 5: Implement competitive list and detail pages**

List page calls `listCompetitiveAnalysesForUser()`, formats created time with existing `formatPmReportCreatedAt()`, and renders columns Analysis ID, Created, Anchor product, Competitors (`competitorNames.length`), Sources (`sourceCount`). Links use `encodeURIComponent(analysis.analysisId)`.

Detail page calls `getCompetitiveAnalysisForUser(analysisId)`, maps invalid/not-found to `notFound()`, uses safe unavailable page otherwise, and renders analysis Markdown, JSON metadata, then original request Markdown. Back links point to `/reports/competitive`.

- [ ] **Step 6: Add focused report-choice styles**

Add:

```css
.studio-report-choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.studio-report-choice {
  display: grid;
  gap: 10px;
  color: inherit;
  text-decoration: none;
  transition: border-color 140ms ease, transform 140ms ease;
}

.studio-report-choice:hover {
  border-color: var(--studio-ink);
  transform: translateY(-2px);
}

.studio-report-choice:focus-visible {
  outline: 2px solid var(--studio-accent);
  outline-offset: 2px;
}
```

Join `.studio-report-choice-grid` to existing mobile one-column selectors.

- [ ] **Step 7: Run page, Markdown, lint, and type checks**

Run: `npx vitest run client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts client/src/components/studio/studio-nav.test.ts client/src/components/markdown-message.test.ts client/src/lib/ui-structure.test.ts`

Expected: all files PASS.

Run: `npm run lint --workspace client`

Expected: PASS.

Run: `npm run typecheck --workspace client`

Expected: PASS.

- [ ] **Step 8: Commit UI slice**

```bash
git add client/src/app/reports/page.tsx client/src/app/reports/weekly/page.tsx client/src/app/reports/competitive/page.tsx client/src/app/reports/competitive/[analysisId]/page.tsx client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts client/src/components/studio/studio-nav.test.ts client/src/lib/ui-structure.test.ts client/src/app/studio.css
git commit -m "feat(client): group PM report views"
```

---

### Task 6: Documentation, Full Verification, And Review

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Consumes: completed Tasks 1-5 behavior.
- Produces: current public, architecture, agent, and operator documentation plus verified branch.

- [ ] **Step 1: Update public README**

Document both PM skills, natural-language and `/competitive-analysis` examples, first-product anchor behavior, automatic expansion to five competitors, 5-7 competitor cap, grouped Reports landing, new routes, complete-only auto-save, and unchanged weekly report behavior. State one-page evidence and no-crawl boundary.

- [ ] **Step 2: Update architecture invariants**

In `AGENTS.md`, add exact skill names, eight direct PM tools, `maxSteps: 18`, search/read/save budgets, evidence states, incomplete unsaved rule, `pca_...` format, fixed object paths, separate list Markdown, client routes/APIs, and unchanged fixed MCP registries/context processors.

In `docs/ARCHITECTURE.md`, update PM Agent, storage, data flow, server boundaries, and public route sections. Include:

```text
user request
  -> competitive-analysis skill
  -> up to 3 search_web calls
  -> up to 8 read_web_page calls
  -> evidence-only synthesis
  -> save_competitive_analysis_to_garage
  -> competitive-analyses/<pca-id>/{request.md,analysis.md,metadata.json}
  -> /reports/competitive/<pca-id>
```

- [ ] **Step 3: Update operations guide**

Document invocation, required complete report sections, one-primary-source rule, `Unknown` semantics, partial failures, saved chat list/view phrases, grouped browser navigation, server API troubleshooting, optional live smoke, and no new environment variables. Repeat Jina privacy/untrusted-content limits without printing credentials.

- [ ] **Step 4: Run focused affected tests**

Run:

```bash
npx vitest run storage/src/competitive-analyses.test.ts storage/src/pm-reports.test.ts agent/src/mastra/tools/competitive-analysis-tools.test.ts agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/processors/context-limit.test.ts client/src/server/competitive-analyses.test.ts client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts client/src/components/studio/studio-nav.test.ts client/src/components/markdown-message.test.ts client/src/lib/ui-structure.test.ts
```

Expected: all deterministic tests PASS, with no live provider access.

- [ ] **Step 5: Run required repository verification**

Run sequentially from repository root:

```bash
npm ci
npm run check
npm run build
git diff --check
```

Expected: all commands exit 0. `npm run check` should report approximately 950 existing tests plus new tests, with only the opt-in live test skipped. If launcher wall-clock test fails, follow systematic-debugging workflow; do not silently raise timeouts or claim success from its isolated pass.

- [ ] **Step 6: Audit tracked state and secrets**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git ls-files "*.env" "*.env.local" "*.db" "*.db-wal" "*.db-shm"
```

Expected: only intended source/docs/test files; no generated `.next`, `.mastra`, database, environment-secret, Docker-state, screenshot, or worktree-pointer files.

- [ ] **Step 7: Request independent review**

Invoke `superpowers:requesting-code-review` against complete diff. Review emphasis: save-gate bypasses, namespace leakage, hostile metadata projection, prompt-injection boundaries, product/source count enforcement, MCP registry preservation, weekly compatibility, route ambiguity, and accessible tables. Fix every Critical and Important finding, then rerun Steps 4-6.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md AGENTS.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git commit -m "docs: document PM competitive analysis"
```

- [ ] **Step 9: Produce completion evidence**

Record exact final commit, `git status --short --branch`, test counts, skipped live tests, build result, and any unresolved non-blocking review findings. Do not push or create a PR unless user explicitly requests it.
