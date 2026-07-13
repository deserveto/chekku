# PM Agent Local Reports Design

## Goal

Add a built-in PM Agent to Chekku that analyzes weekly reports, saves analyses locally, lists saved reports, and views saved reports by id.

## Design

Chekku keeps `main-agent` unchanged. Add a separate built-in `pmAgent` registered in Mastra alongside `mainAgent`. The PM Agent uses the same per-request provider context pattern as `main-agent`, so users continue to supply model endpoint, key, and model from the web UI.

Reports are stored on local disk under `agent/pm-reports/<reportId>/` with three files:

- `input.md`
- `analysis.md`
- `metadata.json`

PM Agent tools:

- `save_pm_report`: saves original report, analysis, and metadata.
- `list_pm_reports`: returns saved metadata newest first.
- `view_pm_report`: returns original input, analysis markdown, and metadata for one report id.

PM Agent behavior:

- Weekly report input produces a Markdown risk analysis and calls `save_pm_report`.
- “list reports” calls `list_pm_reports`.
- “show/view/open/read report <id>” calls `view_pm_report`.
- Non-report questions get normal prose.

## Non-Goals

- No Garage/S3 dependency in Chekku for this change.
- No UI report viewer.
- No report delete.
- No change to `main-agent` browser behavior.
