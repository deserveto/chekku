# PM Competitive Analysis Design

## Status

Approved during brainstorming on 2026-07-23. This specification is ready for
user review before implementation planning.

This specification covers PM Agent skills, bounded competitive research,
Garage persistence, and report browsing. It does not add crawling, recursive
link following, another research provider, or another persistence backend.

## Goal

Make PM Agent expose two first-class, user-invocable Mastra skills:

- `weekly-report-analysis`, preserving current weekly risk analysis behavior;
- `competitive-analysis`, researching an anchor product and at least five
  similar products, comparing evidenced features, saving the completed report
  to Garage, and making it available in chat and the Reports UI.

The competitive-analysis skill uses the existing `search_web` and
`read_web_page` capabilities. Search discovers candidate public URLs. Web
Reader reads one selected public page per invocation. PM Agent, not either
provider tool, selects products, interprets evidence, builds the comparison,
and invokes dedicated competitive-report persistence tools.

## Delivery State And Branch

The approved research sequence is complete through its foundations:

1. SearXNG search merged in PR #7.
2. Hosted Web Reader merged in PR #10 as squash commit `aba81e7`.
3. PM competitive analysis is covered by this specification.

GitHub reported PR #10 merged on 2026-07-23 with successful `verify` CI. The
source branch head `052cebe` and fetched `origin/main` had identical trees after
the squash merge.

The design branch is:

```text
feat/pm-competitive-analysis
```

Its isolated worktree is:

```text
C:\Users\diazh\OneDrive\文档\MAGANG\chekku\.worktrees\pm-competitive-analysis
```

The branch was created directly from fetched `origin/main` at `aba81e7`. Local
`main` contains unrelated local commits and must not become this branch's base.

## Existing Invariants

The change must preserve these boundaries:

- `agent/src/mastra/index.ts` remains the single Mastra composition root.
- All current code-defined agents and registered workflows remain present.
- PM Agent remains code-defined, protected, and bound to the common server
  model.
- PM Agent retains `createAgentMemory()`, `createAgentContextLimiter()`, and
  `createCharBudgetGuard()` in their current order, with the character guard
  last.
- Garage remains a fixed MCP with exactly its five generic object tools.
- SearXNG remains a fixed MCP with exactly `search_web`.
- Web Reader remains a fixed MCP with exactly `read_web_page`.
- Competitive-report tools remain PM-only direct tools. They never enter any
  generic MCP registry or stored-agent tool registry.
- PM report and competitive-analysis storage both use the fixed `pm-agent`
  namespace. Model, browser, route, local user, and tool inputs never select
  that namespace.
- Weekly PM report IDs, objects, tools, list Markdown, APIs, and existing detail
  links remain unchanged.
- Browser modules never import `@chekku/storage`, contact Garage, or receive
  SearXNG or Web Reader credentials.
- Search and Reader secrets, endpoints, headers, raw provider responses, and
  diagnostics never enter model output, stored records, browser state, or safe
  errors.
- Thread ownership, server identity, proxy methods, model normalization, and
  context limits remain unchanged.

The non-blocking PR #10 review follow-ups about IPv6 zone-ID classification and
Mastra private API coupling are outside this feature scope.

## Approaches Considered

### First-Class Skills With Existing Tools

Selected. PM Agent receives inline Mastra skills and directly orchestrates its
existing `search_web` and `read_web_page` tools plus dedicated report storage
tools.

Benefits:

- directly matches the requirement that PM Agent has discoverable skills;
- keeps search and one-page reading as reusable existing capabilities;
- adds no second agent runtime, crawler, batch fetcher, or model pipeline;
- keeps orchestration visible in the agent turn and bounded by existing context
  processors;
- minimizes implementation and review surface.

Tradeoff: exact live-model compliance remains instruction-driven. Deterministic
tests can prove skill metadata, instructions, schemas, budgets, save gates, and
storage behavior, but they must not claim every model always follows the skill.

### Dedicated Mastra Workflow

Rejected for the first release. A workflow could enforce each stage and counter
more mechanically, but product selection and feature synthesis still require
model reasoning inside the workflow. That would introduce nested model
orchestration, a larger runtime boundary, and substantially more tests.

### Hybrid Research Coordinator

Rejected for the first release. A coordinator could gather evidence before PM
Agent synthesis, but it would duplicate existing tool orchestration and create
a batch research abstraction close to the explicitly excluded crawler scope.

## Skill Architecture

### Inline Skills

Create two inline skills with `createSkill()` from `@mastra/core/skills`:

```text
weekly-report-analysis
competitive-analysis
```

Both are user-invocable and registered through PM Agent's `skills` config.
Place their definitions in a focused PM skill module rather than expanding the
agent composition file with two long instruction strings.

`weekly-report-analysis` owns the complete existing weekly analysis contract:

- exact risk report Markdown structure;
- rating-to-status mapping;
- severity rules;
- exact report quotations and concrete-impact requirements;
- automatic `save_pm_report_to_garage` call;
- final `Saved reportId: <reportId>` receipt;
- analysis still returned when Garage save fails.

Its behavior and storage contract do not change.

`competitive-analysis` owns competitive intake, discovery, evidence handling,
comparison, completion rules, output format, and save behavior described below.

### PM Agent Base Instructions

PM Agent base instructions become a concise intent router. They must:

- load `weekly-report-analysis` for weekly engineering reports or explicit
  weekly analysis requests;
- load `competitive-analysis` for explicit skill invocations or equivalent
  natural-language competitive-analysis requests;
- preserve current deterministic weekly list behavior;
- use competitive list/view tools only for explicit competitive requests;
- select view behavior from canonical ID prefix when an ID is supplied;
- answer unrelated messages conversationally.

The literal form `/competitive-analysis ...` is a user prompt convention, not a
new transport-level slash-command router. Natural-language requests remain
supported. `/weekly-report-analysis ...` may invoke the weekly skill similarly.
This feature does not add a `/skills` client command or another command system.

### Invocation Contract

A competitive-analysis request requires at least one product name. Optional
input may include:

- market or category description;
- official product URL;
- seed competitor names or URLs;
- comparison focus areas.

Examples include:

```text
/competitive-analysis GPT vs Claude vs Gemini
Compare Product X with similar incident-management platforms
Run competitive analysis for Product X in the SMB accounting market, focusing on automation
```

The first named product is the anchor. Later named products are required seed
competitors. PM Agent adds candidates until the report includes at least five
competitors.

The first release analyzes five to seven competitors plus the anchor. This cap
keeps all products within the eight-read budget. When a user supplies more than
seven competitors, PM Agent asks the user to narrow the set before research. A
request with fewer than five seed competitors is expanded automatically.

### Agent Step Budget

Raise PM Agent `maxSteps` from 12 to 18. This provides bounded room for skill
loading, discovery, page reads, replacement attempts, synthesis, and save.

This does not weaken the context controls. Memory, token limiting, and the final
character-budget guard stay active. Tool instructions must prefer the minimum
six-product report rather than filling every available step.

## Competitive Research Contract

### Product Count And Selection

A completed report contains:

- one anchor product;
- at least five competitors;
- at most seven competitors;
- six to eight products total.

Candidate selection considers overlapping use case, target customer, market,
and core capability. Search ranking alone is insufficient. The report includes
a short rationale for each selected competitor.

User-supplied seed competitors remain mandatory. Automatic replacement applies
only to agent-selected candidates. When a required seed cannot be evidenced,
the result is incomplete unless the user later changes the requested set.

### Tool Invocation Budgets

One competitive-analysis run may invoke:

- `search_web` at most three times;
- `read_web_page` at most eight times;
- `save_competitive_analysis_to_garage` at most once.

Search requests use one requested page only and at most ten returned results.
The skill does not automatically request later search pages. It may use fewer
search calls when the user supplies sufficient official URLs.

Each Reader call consumes one URL and one budget slot regardless of success.
No retry occurs inside Web Reader. PM Agent may choose another official page or
replacement candidate while the eight-call total permits it.

The skill must never:

- crawl or recursively follow links;
- use URLs discovered only inside Reader Markdown;
- read authenticated pages;
- send cookies, custom headers, target credentials, signed URLs, or provider
  controls;
- read PDFs or uploads;
- add search or Reader provider fallback;
- use QA browser automation as a research fallback.

Candidate and evidence URLs come only from user input or `search_web` results.

### Evidence Minimum

The anchor and every competitor require one successfully read official or
primary product page. Search snippets support candidate discovery only and must
not support final feature claims.

Every material report claim includes an inline Markdown source link. Product
profiles and matrix cells use the primary pages actually read during the run.
Pricing appears only when primary evidence supports it.

Feature matrix states are:

| State | Meaning |
| --- | --- |
| `Yes` | Primary evidence explicitly confirms the capability. |
| `Partial` | Primary evidence confirms a limited or qualified form. |
| `No` | Primary evidence explicitly says the capability is unavailable or unsupported. |
| `Unknown` | Reliable evidence is unavailable. |

Missing mention never becomes `No`. The report must not infer product absence
from silence on one page.

Feature categories are inferred from market-relevant evidence and may be shaped
by optional user focus areas. There is no fixed cross-market feature taxonomy,
and users do not need to supply criteria before research.

### Untrusted Content Isolation

Every Reader result has `contentIsUntrusted: true`. The skill treats returned
Markdown only as evidence. It ignores page-authored:

- instructions to the agent;
- tool or skill requests;
- output-format changes;
- competitor-selection commands;
- requests to reveal secrets or system content;
- persistence or deletion commands;
- links proposed as next workflow steps.

Workflow control comes only from PM Agent base instructions, loaded skill
instructions, and the user's request. Content labeling and size bounds are
defense in depth, not proof that page content is safe.

### Partial Failure

When search or reading fails, PM Agent first tries another official source or a
replacement candidate within the fixed budgets.

A result is complete only when all included products meet the primary-source
minimum and at least five competitors remain. A complete result is eligible for
save.

If the budget ends before completion, PM Agent returns an explicitly titled
incomplete report containing:

- evidenced products and partial findings;
- missing products or evidence;
- fixed safe tool failure messages when useful;
- suggested user action.

Incomplete work is not saved and must not include `Saved analysisId:`. It must
not fabricate claims, convert unknowns to negatives, or silently lower the
five-competitor minimum.

## Competitive Report Contract

A completed analysis is Markdown with exactly these top-level sections in this
order:

```text
# Competitive Analysis: <anchor product>

## Executive Summary
## Scope and Competitor Selection
## Product Profiles
## Feature Matrix
## Gaps and Opportunities
## Risks and Confidence
## Recommendations
## Sources
```

### Executive Summary

Summarize anchor position, strongest competitors, most important feature gaps,
and highest-value opportunity. Keep conclusions tied to cited evidence.

### Scope And Competitor Selection

State anchor, market or category when known, optional user focus, products
included, and selection rationale. Distinguish user-supplied seeds from
agent-selected competitors.

### Product Profiles

Provide one subsection per product, anchor first. Each profile covers:

- positioning and target users;
- evidenced core capabilities;
- differentiators;
- pricing only when evidenced, otherwise `Unknown`;
- limitations or evidence gaps;
- primary source.

### Feature Matrix

Use a GFM table with features as rows and products as columns. Cells contain
`Yes`, `Partial`, `No`, or `Unknown` plus inline citations when evidence supports
the state. Long tables rely on the existing accessible Markdown table wrapper.

### Gaps, Risks, And Recommendations

Gaps and Opportunities compares the anchor against evidenced competitor
capabilities. Risks and Confidence identifies evidence limits, stale or
ambiguous public claims, and unsupported comparisons. Recommendations prioritize
concrete product actions for the anchor without presenting speculation as fact.

### Sources

List every primary source used, grouped by product. Do not include unread search
results as evidence sources.

## Garage Persistence

### Separate Domain Type

Competitive analyses use a separate domain repository layered above the
existing generic object-storage contract. This is not a new persistence system.
It uses the same Garage adapter and fixed `pm-agent` namespace as weekly PM
reports while preserving separate IDs, paths, metadata, and tools.

Add the domain to `storage/` and export its public repository types and helpers
through `storage/src/index.ts`.

### Canonical IDs And Paths

Canonical analysis IDs use:

```text
pca_YYYYMMDDHHMMSS_<8 lowercase hex>
```

Every repository, PM tool, server service, API, and page detail boundary
enforces:

```text
^pca_[0-9]{14}_[0-9a-f]{8}$
```

Each analysis stores three logical objects:

```text
competitive-analyses/<analysisId>/request.md
competitive-analyses/<analysisId>/analysis.md
competitive-analyses/<analysisId>/metadata.json
```

`metadata.json` writes last so partial object writes never become list entries.
Lists skip malformed or noncanonical metadata. There is no migration or fallback
to weekly PM objects, generic development objects, or noncanonical records.

### Metadata

Persist only:

```text
analysisId
createdAt
anchorProduct
market (optional)
competitorNames
productCount
sourceCount
requestObjectKey
analysisObjectKey
metadataObjectKey
```

Anchor and competitor names are trimmed, nonblank, and at most 256 UTF-8 bytes.
Optional market text is trimmed, nonblank when present, and at most 512 UTF-8
bytes. Competitors are case-insensitively unique and do not duplicate the
anchor. Metadata contains five to seven competitor names, product count six to
eight, and source count equal to product count. Repository code derives counts
rather than trusting model-provided count fields.

All object keys are relative. Physical
`agents/<base64url(pm-agent)>/...` prefixes never enter metadata, tool output,
API output, pages, or errors.

### Save Gate

`save_competitive_analysis_to_garage` accepts strict structured input:

```text
requestMarkdown
analysisMarkdown
anchorProduct
market (optional)
competitorNames
sources
```

`sources` contains one primary HTTP(S) source URL mapped to each product. The
tool validates:

- five to seven unique competitors;
- anchor and competitor uniqueness;
- exactly one source mapping for every product;
- source product names exactly cover anchor plus competitors;
- unique normalized public HTTP(S) source URLs accepted by the existing public
  URL policy, each at most 2,048 UTF-8 bytes;
- nonblank request and analysis Markdown, each at most 262,144 UTF-8 bytes.

The save tool derives `productCount` and `sourceCount` after validation and then
calls the shared repository. This makes the product and source minimum a
deterministic persistence boundary even though research and prose remain
model-driven.

The tool does not parse the report to prove every individual citation or matrix
cell. Those remain skill-contract requirements.

### PM Agent Tools

Add three PM-only direct tools:

```text
save_competitive_analysis_to_garage
list_competitive_analyses_from_garage
view_competitive_analysis_from_garage
```

They are not part of Garage MCP, SearXNG MCP, Web Reader MCP, or
`storedAgentTools`.

The list tool returns structured metadata plus presentation-only:

```text
analysisUrl
analysesMarkdown
```

`analysisUrl` is:

```text
/reports/competitive/<url-encoded-analysisId>
```

`analysesMarkdown` is deterministic GFM with columns Analysis, Created, Anchor,
Competitors, and Sources. Rows are newest first. Empty output is exactly:

```text
No saved competitive analyses found.
```

Names and timestamps receive the same bounded deterministic Markdown-safe
formatting principles as weekly lists. Presentation fields never enter stored
metadata, save output, view output, or repository types.

The view tool returns request Markdown, analysis Markdown, and metadata for one
canonical ID.

### Agent Save And Retrieval Behavior

After producing a complete report, PM Agent calls the save tool once. Its final
reply includes the full analysis followed by:

```text
Saved analysisId: <analysisId>
```

If save fails, PM Agent still returns the full analysis and one short safe line
explaining that Garage save failed.

When asked to list saved competitive analyses, PM Agent calls the competitive
list tool and returns `analysesMarkdown` unchanged. When asked to view one, it
returns saved analysis first and a short metadata block second.

Existing generic requests to list saved reports continue to mean weekly reports
for compatibility. Canonical `pca_...` IDs select competitive view behavior;
canonical `pmr_...` IDs select weekly view behavior.

## Browser And Server Design

### Navigation And Pages

Keep one sidebar link named Reports pointing to `/reports`.

`/reports` becomes a grouped landing page with two choices:

- Weekly Reports;
- Competitive Analyses.

Routes are:

```text
/reports                              grouped report landing
/reports/weekly                       weekly report list
/reports/<pmr-id>                     existing weekly detail, preserved
/reports/competitive                  competitive analysis list
/reports/competitive/<pca-id>         competitive analysis detail
```

The existing weekly detail route remains unchanged so stored chat links and
bookmarks do not break. The existing weekly list tool also keeps its current
`/reports/<pmr-id>` links.

The competitive list table contains:

```text
Analysis ID
Created
Anchor product
Competitors
Sources
```

The competitive detail page renders:

1. saved analysis Markdown;
2. metadata;
3. original request Markdown.

Weekly and competitive list tables remain horizontally scrollable, keyboard
focusable, labeled as regions, and visibly outlined on focus. Feature matrices
render through the existing Markdown renderer and accessible table wrapper.

### Server-Only Boundary And APIs

Add a focused server-only competitive-analysis service parallel to the existing
PM report service. It:

- requires the current server identity seam;
- fixes storage to the `pm-agent` namespace;
- validates canonical `pca_...` IDs before reads;
- returns safe bounded errors;
- imports `@chekku/storage` only from server code.

Keep current weekly APIs unchanged. Add:

```text
GET /api/storage/competitive-analyses
GET /api/storage/competitive-analyses/<analysisId>
```

Error mapping follows current PM report behavior:

- missing identity: 403;
- invalid ID: 400 or page not-found;
- missing analysis: 404;
- storage failure: 503.

Provider details, physical keys, credentials, headers, and raw storage errors do
not enter responses or pages.

## Error And Safety Boundaries

This feature composes existing safe search, Reader, and Garage errors. It does
not weaken them or add raw diagnostic logging.

The skill distinguishes:

- research incomplete: return partial unsaved analysis;
- report complete but Garage save failed: return complete analysis with safe
  save-failure line;
- list/view unavailable: return fixed storage error;
- invalid canonical ID: reject before storage access.

No error includes target query strings, URL fragments, server credentials,
provider endpoints, request headers, raw bodies, request IDs, stacks, or
physical storage prefixes.

## Testing Strategy

Implementation follows regression-first TDD with existing Vitest setup.

### Skills And PM Agent

- PM Agent exposes `weekly-report-analysis` and `competitive-analysis` through
  `listSkills()` with user-invocable metadata.
- Explicit and natural-language routing requirements remain present in base
  instructions.
- Weekly skill instructions preserve the exact current weekly report contract.
- Competitive skill instructions contain trigger, anchor, product count,
  selection, tool budget, evidence, matrix-state, untrusted-content, partial
  failure, output, and save requirements.
- PM Agent retains its five existing direct tools and gains exactly the three
  competitive-analysis storage tools.
- PM Agent default options use `maxSteps: 18`.
- Memory and input processor behavior remain active and ordered.

### Competitive Repository

- Generate canonical `pca_...` IDs.
- Reject invalid IDs on direct reads.
- Persist only relative canonical keys under the fixed namespace.
- Write request and analysis before metadata.
- List newest first and skip malformed/noncanonical metadata.
- Validate bounded, unique anchor and competitor names.
- Derive product and source counts.
- Round-trip save and get results.
- Preserve fixed safe object-storage errors and namespace isolation.

### PM Tools

- Enforce strict save input and reject extra fields.
- Require five to seven competitors.
- Require exact product-to-primary-source coverage.
- Reject duplicate products, duplicate URLs, missing sources, non-public URLs,
  and blank Markdown before storage access.
- Return canonical relative metadata only.
- Render deterministic newest-first list Markdown and exact empty text.
- Escape names safely and produce URL-encoded relative links.
- Prove presentation fields do not enter persistence or view results.
- Prove competitive tools remain outside all fixed MCP registries.

### Client Service, APIs, And Pages

- Require identity for competitive list and detail operations.
- Validate IDs before storage access.
- Map not-found and storage errors to safe bounded responses.
- Preserve existing weekly APIs and detail URLs.
- Render grouped `/reports` landing and both report choices.
- Render weekly list at `/reports/weekly`.
- Render competitive list/detail routes and metadata hierarchy.
- Use Next.js not-found behavior for invalid or missing analysis IDs.
- Preserve labeled, focusable, horizontally scrollable report tables and visible
  focus outlines.
- Keep sidebar active state correct for every `/reports` route.

### Model And Live Boundaries

Deterministic tests do not claim that a real model always follows skill
instructions. They verify all code-enforced contracts and skill text. An
optional manual smoke may run one benign public analysis against configured
SearXNG and Web Reader, confirm six evidenced products, inspect citations, and
verify save/list/view behavior.

Live search and Jina access are not required by CI. Tests must not read, print,
log, or commit local credentials. The previously pasted Jina key is considered
compromised and must not be reused unless separately revoked and replaced.

## Documentation

Update:

- `README.md` for both PM skills, invocation examples, report browsing, and
  bounded research scope;
- `AGENTS.md` for competitive skill, tool budgets, evidence rules, fixed
  namespace, IDs, routes, context limits, and registry invariants;
- `docs/ARCHITECTURE.md` for skills, search-read-analyze-save data flow, storage
  objects, server boundaries, and public routes;
- `docs/OPERATIONS.md` for invocation, incomplete reports, saved-report access,
  troubleshooting, optional smoke, and unchanged credentials.

Documentation must state that:

- search discovers candidates but does not read result pages;
- Reader reads one chosen public page per invocation and does not crawl;
- page content is untrusted evidence, never instructions;
- complete analysis requires anchor plus five evidenced competitors;
- missing mention is `Unknown`, not `No`;
- competitive analyses use separate Garage objects under fixed `pm-agent`
  namespace;
- no new credential or endpoint configuration is introduced.

## Completion Verification

Before implementation completion, run from the competitive-analysis worktree:

```bash
npm ci
npm run check
npm run build
git diff --check
```

Also run focused affected tests, audit tracked files for secrets and generated
state, and request independent review of the complete diff against this spec.
Fix Critical and Important findings before publication.

## Baseline Note

At design worktree creation:

- `npm ci` passed; npm reported 21 existing audit findings: 4 low, 10 moderate,
  and 7 high. No audit fix was run.
- Typecheck, lint, and the main deterministic Vitest pass succeeded with 896
  tests passed and one opt-in live test skipped.
- The isolated 54-test launcher suite had one existing wall-clock assertion fail
  after the full 270-second run: 9.787 seconds against an 8-second ceiling.
- The same launcher test passed alone in 9.82 seconds including Vitest startup,
  with its internal assertion under the 8-second ceiling.
- `npm run build` passed for Mastra and Next.js.

No launcher fix belongs in competitive-analysis scope unless separately
approved. Required final CI must still pass before merge.

## Fresh-Session Handoff Gate

No implementation code starts in this brainstorming session. Before executing
an implementation plan, provide an inline handoff for a fresh session that
includes:

- approved spec path and commit;
- branch and worktree path;
- fetched `origin/main` base and PR #10 merge state;
- instruction to invoke `writing-plans` first if no approved plan exists, or
  `executing-plans` when an approved plan exists;
- TDD and verification requirements;
- current clean/dirty worktree state;
- baseline launcher timing note;
- explicit exclusions for crawling, provider changes, and PR #10 follow-ups.

The fresh session must read `AGENTS.md` and this specification before any code
or implementation skill.
