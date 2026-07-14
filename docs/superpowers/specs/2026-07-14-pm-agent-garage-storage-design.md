# PM Agent Garage Storage Design

## Goal

Replace Chekku PM Agent's local filesystem report storage with Garage object storage, matching the Aether PM report tools and object layout.

## Current State

Chekku has a built-in `pm-agent` that analyzes weekly engineering reports. It currently uses local filesystem tools:

- `save_pm_report`
- `list_pm_reports`
- `view_pm_report`

Reports are written under `process.cwd()/pm-reports/<reportId>/` as `input.md`, `analysis.md`, and `metadata.json`.

Aether implements the same PM report workflow against Garage through S3-compatible object storage. It stores objects under `pm-reports/<reportId>/` and exposes Garage-specific Mastra tools.

## Approach

Use a direct Aether-style replacement adapted to Chekku's structure:

- Add `@aws-sdk/client-s3` to the `agent` workspace.
- Add server-only Garage env vars to `agent/src/config/env.ts`:
  - `GARAGE_ENDPOINT`
  - `GARAGE_REGION`
  - `GARAGE_BUCKET`
  - `GARAGE_ACCESS_KEY_ID`
  - `GARAGE_SECRET_ACCESS_KEY`
- Add a lazy Garage report store that creates an S3-compatible client only when a Garage tool runs.
- Replace PM Agent's local report tools with Garage tools:
  - `save_pm_report_to_garage`
  - `list_pm_reports_from_garage`
  - `view_pm_report_from_garage`
- Update PM Agent instructions so report analysis writes to Garage and returns the saved `reportId`.

## Object Layout

Garage objects use the same layout as Aether:

```text
pm-reports/<reportId>/input.md
pm-reports/<reportId>/analysis.md
pm-reports/<reportId>/metadata.json
```

Metadata contains:

- `reportId`
- `createdAt`
- `rating`
- `status`
- `inputObjectKey`
- `analysisObjectKey`
- `metadataObjectKey`

Local filesystem path fields are removed from active PM Agent report results.

## Components

### Garage Store

Add `agent/src/mastra/pm-reports/garage-store.ts`.

Responsibilities:

- Read and validate Garage config from server env.
- Create an S3 client with `forcePathStyle: true`.
- Write text objects with content type.
- Read text objects.
- List metadata objects under `pm-reports/`, including paginated `ListObjectsV2` results.
- Defer config validation until first tool execution so server startup still works before Garage is configured.

### PM Report Store

Refactor `agent/src/mastra/pm-reports/store.ts` from filesystem persistence to object-store persistence.

Responsibilities:

- Keep risk-header parsing and report id generation.
- Save report input, analysis, and metadata through a `PmReportObjectStore` interface.
- List metadata through `store.listText('pm-reports/')`.
- Read report objects by generated object keys.

### Garage Tools

Replace `agent/src/mastra/tools/pm-report-tools.ts` with Garage-backed tool factories and exports.

Responsibilities:

- Validate tool inputs with Zod.
- Call `ensureReady()` before storage operations.
- Return object-key metadata matching Aether.
- Expose test seams through `storeFactory` and `now` options.

### PM Agent

Update `agent/src/agents/pm-agent.ts`:

- Import Garage tools.
- Register only Garage report tools.
- Update instructions to call Garage tools for save, list, and view behavior.
- Preserve existing report analysis template and Memory.

## Error Handling

Missing Garage configuration should throw a clear server-side error naming required env vars. Secrets must never appear in errors, logs, docs examples, or client-visible config.

If Garage save fails after analysis, PM Agent should still return the Markdown analysis and add one short line saying Garage save failed.

Invalid PM Agent output without a parseable risk header should continue to fail with `PM Agent output is missing a parseable risk rating header`.

## Testing

Add or update Vitest coverage for:

- Garage env config defaults and valid values.
- Missing Garage config error from `readGarageConfig()`.
- Saving through Garage tool writes input, analysis, metadata objects and returns object-key metadata.
- Missing risk header rejection.
- Listing and viewing reports through in-memory object-store test doubles.
- PM Agent has Garage tool ids and no local report tool ids.

## Documentation

Update:

- `agent/.env.example` with Garage env placeholders.
- `README.md` agent server env table.
- `docs/OPERATIONS.md` storage/config guidance.
- `docs/ARCHITECTURE.md` if PM Agent storage behavior is described there.

## Non-Goals

- No client-side Garage credentials.
- No generic file manager tool.
- No S3 browser upload flow.
- No local/Garage backend selector.
- No PM report delete feature.
- No custom PM report HTTP routes.
