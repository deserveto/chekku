# PM Report Chat Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PM Agent saved-report lists render as deterministic, clickable, responsive Markdown tables instead of model-generated inline prose.

**Architecture:** The PM list tool keeps its structured `reports` array and adds a deterministic presentation-only `reportsMarkdown` string. PM Agent returns that string unchanged, while the existing GFM renderer wraps all Markdown tables in a styled horizontal-scroll container.

**Tech Stack:** TypeScript, Mastra tools/Agent, Zod, React 19, `react-markdown`, `remark-gfm`, CSS, Vitest.

## Global Constraints

- `reportsMarkdown` and `reportUrl` exist only in list-tool output.
- Persisted metadata, storage repository types, save output, and view output remain unchanged.
- Rows remain newest first in repository order.
- Table header is exactly `| Report | Created | Risk | Status |`.
- Alignment row is exactly `| --- | --- | ---: | --- |`.
- Valid timestamps render as `YYYY-MM-DD HH:mm UTC`; invalid timestamps remain unchanged.
- Empty output is exactly `No saved reports found.`
- Report IDs remain clickable through URL-encoded relative `/reports/<reportId>` links.
- PM Agent returns `reportsMarkdown` unchanged without reconstruction, summaries, or prose conversion.
- Tables scroll horizontally on narrow screens instead of compressing columns.
- No new dependency.
- Follow TDD and keep all commits local until user approves a push.

---

### Task 1: Generate Deterministic Report Table Markdown

**Files:**
- Modify: `agent/src/mastra/tools/pm-report-tools.ts`
- Modify: `agent/src/mastra/tools/pm-report-tools.test.ts`
- Modify: `agent/src/agents/pm-agent.ts`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Consumes: existing `PmReportMetadata` and newest-first `listPmReports()` output.
- Produces: `formatPmReportsMarkdown(reports)` and list output `{ reports, reportsMarkdown }`.

- [ ] **Step 1: Write failing formatter tests**

Import `formatPmReportsMarkdown` and add direct tests using two list items:

```ts
const reports = [
  {
    reportId: 'pmr_new',
    reportUrl: '/reports/pmr_new',
    createdAt: '2026-07-15T11:26:42.702Z',
    rating: 8,
    status: 'IN-DANGER' as const,
    inputObjectKey: 'pm-reports/pmr_new/input.md',
    analysisObjectKey: 'pm-reports/pmr_new/analysis.md',
    metadataObjectKey: 'pm-reports/pmr_new/metadata.json',
  },
  {
    reportId: 'pmr_old',
    reportUrl: '/reports/pmr_old',
    createdAt: 'not|a\\date',
    rating: 4,
    status: 'WARNING' as const,
    inputObjectKey: 'pm-reports/pmr_old/input.md',
    analysisObjectKey: 'pm-reports/pmr_old/analysis.md',
    metadataObjectKey: 'pm-reports/pmr_old/metadata.json',
  },
];

expect(formatPmReportsMarkdown(reports)).toBe([
  '| Report | Created | Risk | Status |',
  '| --- | --- | ---: | --- |',
  '| [pmr_new](/reports/pmr_new) | 2026-07-15 11:26 UTC | 8/10 | IN-DANGER |',
  '| [pmr_old](/reports/pmr_old) | not\\|a\\\\date | 4/10 | WARNING |',
].join('\n'));

expect(formatPmReportsMarkdown([])).toBe('No saved reports found.');
```

Extend the existing integration test so list output includes `reportsMarkdown`, while save/view/persisted metadata still omit both presentation fields where required.

- [ ] **Step 2: Run formatter tests and verify RED**

Run:

```bash
npx vitest run agent/src/mastra/tools/pm-report-tools.test.ts
```

Expected: FAIL because `formatPmReportsMarkdown` and `reportsMarkdown` do not exist.

- [ ] **Step 3: Implement minimal formatter and list schema**

Add focused types/helpers in `pm-report-tools.ts`:

```ts
type PmReportListItem = PmReportMetadata & { reportUrl: string };

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return escapeMarkdownCell(createdAt);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatPmReportsMarkdown(reports: readonly PmReportListItem[]): string {
  if (reports.length === 0) return 'No saved reports found.';
  const rows = reports.map((report) =>
    `| [${escapeMarkdownCell(report.reportId)}](${report.reportUrl}) | ${formatCreatedAt(report.createdAt)} | ${report.rating}/10 | ${report.status} |`,
  );
  return [
    '| Report | Created | Risk | Status |',
    '| --- | --- | ---: | --- |',
    ...rows,
  ].join('\n');
}
```

Import `type PmReportMetadata`. Extend list output schema with `reportsMarkdown: z.string()`. Build list items once, then return both:

```ts
const reports = (await listPmReports(store)).map((report) => ({
  ...report,
  reportUrl: `/reports/${encodeURIComponent(report.reportId)}`,
}));
return { reports, reportsMarkdown: formatPmReportsMarkdown(reports) };
```

- [ ] **Step 4: Update PM Agent instruction test and instruction**

Replace old URL-template assertions with:

```ts
expect(instructions).toContain('reportsMarkdown');
expect(instructions).toContain('return it unchanged');
expect(instructions).toContain('Do not reconstruct');
```

Run test to verify RED, then update list instructions to:

```text
Call the list_pm_reports_from_garage tool. Return its reportsMarkdown value unchanged. Do not reconstruct, summarize, reorder, or convert the rows into prose.
```

- [ ] **Step 5: Verify Task 1 GREEN**

Run:

```bash
npx vitest run agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/mcp/garage-mcp-server.test.ts
npm run typecheck --workspace agent
git diff --check
```

Expected: all targeted tests and agent typecheck PASS. MCP list output automatically carries the updated shared tool result.

- [ ] **Step 6: Commit Task 1 locally**

```bash
git add agent/src/mastra/tools/pm-report-tools.ts agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/pm-agent.ts agent/src/agents/__tests__/both-agents.test.ts
git commit -m "feat(agent): format report lists as tables"
```

### Task 2: Render Responsive Markdown Tables In Chat

**Files:**
- Modify: `client/src/components/markdown-message.tsx`
- Modify: `client/src/components/markdown-message.test.ts`
- Modify: `client/src/app/globals.css`

**Interfaces:**
- Consumes: GFM table Markdown, including Task 1 `reportsMarkdown`.
- Produces: `.markdown-table-wrap` around rendered `<table>` elements.

- [ ] **Step 1: Write failing renderer test**

Render a complete table with clickable report ID:

```ts
const content = [
  '| Report | Created | Risk | Status |',
  '| --- | --- | ---: | --- |',
  '| [pmr_test](/reports/pmr_test) | 2026-07-15 11:26 UTC | 8/10 | IN-DANGER |',
].join('\n');
const markup = renderToStaticMarkup(createElement(MarkdownMessage, { content }));

expect(markup).toContain('<div class="markdown-table-wrap">');
expect(markup).toContain('<table>');
expect(markup).toContain('href="/reports/pmr_test"');
expect(markup).toContain('target="_blank"');
expect(markup).toContain('rel="noreferrer"');
expect(markup).toContain('>Risk</th>');
```

- [ ] **Step 2: Run renderer test and verify RED**

Run:

```bash
npx vitest run client/src/components/markdown-message.test.ts
```

Expected: FAIL because no `.markdown-table-wrap` exists.

- [ ] **Step 3: Add table wrapper**

Extend `components` in `MarkdownMessage`:

```tsx
table: ({ children, ...props }) => (
  <div className="markdown-table-wrap">
    <table {...props}>{children}</table>
  </div>
),
```

Preserve existing safe link and code-block overrides.

- [ ] **Step 4: Write failing CSS contract test**

Read `globals.css` in `markdown-message.test.ts`:

```ts
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
expect(css).toContain('.markdown-table-wrap');
expect(css).toContain('overflow-x: auto');
expect(css).toContain('white-space: nowrap');
expect(css).toContain('nth-child(3)');
```

Run the focused test and confirm RED because styles are absent.

- [ ] **Step 5: Add responsive table styles**

Append to `globals.css`:

```css
.markdown-table-wrap {
  width: 100%;
  margin: 8px 0;
  overflow-x: auto;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  background: var(--canvas-deep);
}

.markdown-table-wrap table {
  width: 100%;
  min-width: 600px;
  border-collapse: collapse;
  font-size: 12px;
}

.markdown-table-wrap th,
.markdown-table-wrap td {
  padding: 8px 10px;
  border-right: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  white-space: nowrap;
  text-align: left;
}

.markdown-table-wrap th {
  color: var(--muted);
  font: 10px var(--font-dm-mono);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.markdown-table-wrap th:nth-child(3),
.markdown-table-wrap td:nth-child(3) {
  text-align: right;
}

.markdown-table-wrap th:last-child,
.markdown-table-wrap td:last-child {
  border-right: 0;
}

.markdown-table-wrap tbody tr:last-child td {
  border-bottom: 0;
}
```

- [ ] **Step 6: Run full verification**

```bash
npm ci
npm run check
npm run build
git diff --check
git status --short
```

Expected: full check and builds PASS; status contains only intended Task 2 files before commit.

- [ ] **Step 7: Commit Task 2 locally**

```bash
git add client/src/components/markdown-message.tsx client/src/components/markdown-message.test.ts client/src/app/globals.css
git commit -m "feat(client): style report tables in chat"
```

- [ ] **Step 8: Stop before remote operations**

Do not push. Present branch, commits, verification evidence, and residual limitation that model compliance is improved but direct tool-result UI rendering is future work.
