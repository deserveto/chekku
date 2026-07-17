# PM Report Chat Table Design

## Goal

Make PM Agent saved-report lists readable, consistently formatted, and directly navigable from chat.

## Current Problem

The list tool returns structured report metadata and a `reportUrl`, but PM Agent must construct presentation itself. Some models ignore the requested Markdown-link format and emit dense inline text such as:

```text
pmr_... -- timestamp -- 8/10 -- IN-DANGER
```

Prompt-only formatting is not reliable enough for this presentation contract.

## Tool Output

`list_pm_reports_from_garage` continues returning its structured `reports` array. It also returns `reportsMarkdown`, a presentation-only GFM table generated deterministically by tool code.

For non-empty results, the value uses this exact structure:

```markdown
| Report | Created | Risk | Status |
| --- | --- | ---: | --- |
| [pmr_20260715112642_e720cebd](/reports/pmr_20260715112642_e720cebd) | 2026-07-15 11:26 UTC | 8/10 | IN-DANGER |
```

Rows remain newest first, matching repository order.

The Report cell uses the existing URL-encoded `reportUrl`. Created timestamps are valid ISO timestamps formatted as `YYYY-MM-DD HH:mm UTC`. Risk is `<rating>/10`. Status remains the stored enum value.

For an empty result, `reportsMarkdown` is exactly:

```text
No saved reports found.
```

## PM Agent Behavior

When asked to list saved reports, PM Agent calls `list_pm_reports_from_garage` and returns `reportsMarkdown` unchanged. It must not reconstruct, summarize, reorder, or convert rows into prose.

View/read behavior remains unchanged. Asking to view a specific report still returns saved analysis and metadata.

## Data Boundary

`reportsMarkdown` and `reportUrl` are list-presentation fields only.

They are not added to:

- persisted report metadata;
- save-tool output;
- view-tool output;
- storage repository types.

The structured `reports` array remains available for programmatic consumers.

## Markdown Safety

Table generation escapes Markdown cell delimiters and backslashes before interpolation. Report links use URL-encoded report IDs from the existing validated report identifier. Tool output does not accept arbitrary HTML.

## Chat Rendering

The existing `remark-gfm` renderer parses the table. `MarkdownMessage` supplies a table override that wraps rendered tables in a dedicated horizontally scrollable container.

Table styling follows the existing studio visual language:

- subtle borders and panel background;
- compact cell padding;
- left-aligned text columns;
- right-aligned Risk column;
- underlined report links;
- no wrapping for IDs, timestamps, risk, or status;
- horizontal scrolling on narrow screens rather than compressed columns.

The same renderer behavior applies to any valid Markdown table, not only PM reports.

## Failure Behavior

- Empty report list: return the exact empty message.
- Invalid stored timestamp: preserve the original `createdAt` text rather than throwing during list presentation.
- Garage/list failure: preserve existing tool error behavior; do not fabricate a table.
- Model ignores instruction: structured tool result still contains deterministic `reportsMarkdown` for debugging and future direct tool-result rendering.

## Testing

Agent tests verify:

- exact header and alignment row;
- newest-first rows;
- clickable URL-encoded report IDs;
- compact UTC timestamps;
- risk and status cells;
- exact empty message;
- list-only presentation fields;
- PM Agent instruction to return `reportsMarkdown` unchanged.

Client tests verify:

- GFM table renders as a table;
- report link keeps relative `href`, `target="_blank"`, and `rel="noreferrer"`;
- table receives the responsive wrapper class;
- CSS contains overflow and table-layout hooks.

Full repository verification remains:

```bash
npm run check
npm run build
git diff --check
```
