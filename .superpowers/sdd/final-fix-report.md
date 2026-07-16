# Final Fix Report

## Status

DONE

## Finding Dispositions

### 1. Untrusted PM metadata

Fixed in `ac1848a`.

- Replaced metadata type-guard passthrough with validation plus exact projection to the seven approved `PmReportMetadata` fields.
- Repository list and read results discard `reportUrl`, `reportsMarkdown`, physical namespace fields, and nested arbitrary data.
- PM list/view tools, server service, APIs, and pages inherit projected repository results; strict tool output schemas no longer receive hostile unknown fields.
- Repository regression covers both list and read. API regression covers both list and detail responses using hostile stored JSON.

### 2. Reports list timestamps

Fixed in `ac1848a`.

- Added server-only `formatPmReportCreatedAt()` using shared strict `parsePmReportTimestamp()` validation.
- Valid RFC3339 timestamps render as compact UTC text.
- Invalid calendar dates and arbitrary invalid text remain unchanged and never render as `Invalid Date`.
- Rendered page regression covers offset conversion, impossible date preservation, and arbitrary invalid text preservation.

### 3. PM Agent instruction contract

Fixed in `ac1848a`.

- Replaced fragment assertions with full instruction equality.
- Assertion locks complete risk template content and order, deterministic list instructions, link form, save behavior, and save-failure fallback.

## TDD Evidence

RED:

- `npx vitest run storage/src/pm-reports.test.ts`: hostile repository metadata regression failed because four unknown fields survived.
- `npx vitest run client/src/server/pm-reports.test.ts client/src/app/reports/reports-pages.test.ts`: API hostile metadata regression failed; three timestamp cases failed through locale normalization, impossible-date rollover, and `Invalid Date` output.
- Full PM instruction equality passed against unchanged production instructions, strengthening contract coverage without production changes.

GREEN:

- `npx vitest run storage/src/pm-reports.test.ts agent/src/mastra/tools/pm-report-tools.test.ts agent/src/agents/__tests__/both-agents.test.ts`: 3 files, 67 tests passed.
- `npx vitest run client/src/server/pm-reports.test.ts client/src/app/reports/reports-pages.test.ts`: 2 files, 38 tests passed.
- `npm run typecheck --workspace @chekku/storage`: passed.
- `npm run typecheck --workspace client`: passed.

## Full Verification

- `npm run check`: typecheck, lint, 37 test files, and 299 tests passed.
- `npm run build`: Mastra and Next.js production builds passed; report pages and APIs were present in route output.
- `git diff --check`: passed before implementation commit.
- `client/next-env.d.ts`: restored from build-generated `.next/types/routes.d.ts` to original `.next/dev/types/routes.d.ts` reference.
- No push or other remote operation performed.

## Self-Review

- Generic Garage MCP implementation and five-tool registry remain unchanged.
- Fixed `pm-agent` namespace and relative-key boundaries remain unchanged.
- No secrets, local state, generated build output, or physical namespace fields were added to public results.
- No documentation update required because public routes, environment variables, commands, and documented behavior remain unchanged.
- No remaining concerns found.

## Commits

- `ac1848a fix: harden PM report metadata`
