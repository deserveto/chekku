# Competitive Analysis Slide Deck (Marp)

## Goal

After every completed `/competitive-analysis` run, produce a shareable, narrative-form slide deck rendered from the analysis via Marp. Surface a working in-app slides link (local-only) next to the saved analysis.

## Scope

**v1 (this spec)**:

- Auto-generate `slides.md` (Marp markdown) as part of every complete competitive-analysis save.
- New client route `/reports/competitive/<id>/slides` rendering the deck.
- Browser print-to-PDF via `window.print()` and print CSS.
- Surfacing the link in chat, detail page, and card grid.

**Deferred (v2)**:

- PPTX export (needs server-side Chromium).
- Public unauthenticated sharing (signed URL or new public route).
- Custom brand theming.
- Weekly report slides.
- Slide editing UI.

## Architecture

```
Chat: /competitive-analysis gpt vs claude vs gemini
  -> PM Agent run (existing budget: 5 search / 8 read / 1 save)
     -> drafts analysis.md (existing)
     -> [NEW] drafts slides.md (Marp markdown, narrative deck)
     -> save_competitive_analysis_to_garage persists both
     -> returns analysis + "Saved analysisId: pca_..." + View slides link
  -> user clicks link
  -> /reports/competitive/<id>/slides (server component, CHEKKU_LOCAL_USER_ID)
     -> fetches via existing /api/storage/competitive-analyses/[id]
     -> <CompetitiveSlides> client component
        -> dynamic import('@marp-team/marp-core')
        -> new Marp().render(slidesMarkdown) -> {html, css}
        -> inject into scoped container
        -> Print button -> window.print() -> browser PDF
```

## Agent layer

### `competitive-analysis` skill

Append a new section to `competitiveAnalysisInstructions` in `agent/src/agents/pm-agent-skills.ts`:

- After drafting analysis.md and BEFORE calling `save_competitive_analysis_to_garage`, produce `slidesMarkdown`.
- Marp front-matter exactly:

  ```
  ---
  marp: true
  theme: default
  paginate: true
  size: 16:9
  ---
  ```

- 10-14 narrative slides: title, agenda, exec summary, one slide per top 3-5 competitors, feature matrix slide(s), top 3 gaps, top 3 recommendations, sources.
- Content rules:
  - No new claims beyond analysis.md.
  - Preserve every inline primary-source link.
  - If Feature Matrix has more than 5 product columns, split into two slides or apply a per-slide `<!-- size: 4:3 -->` directive.
- Required for the complete-report branch. The incomplete branch produces no slidesMarkdown, no `Saved analysisId:`, and no `View slides` link (existing invariants unchanged).
- After a successful complete save, append to the final response: `View slides: /reports/competitive/<analysisId>/slides`

### `save_competitive_analysis_to_garage` tool

- Input schema gains required `slidesMarkdown: z.string()` for complete saves. Missing or empty `slidesMarkdown` rejects the save with a fixed actionable error (keeps "complete-only save" invariant).
- Persists new sibling object key `slides.md` alongside existing `request.md`, `analysis.md`, `metadata.json`.
- `metadata.json` shape unchanged; presence of `slides.md` is the slides-available signal.
- Save failure does not consume the save slot (existing invariant; unchanged).

## Storage layer

- Canonical persisted keys for `competitive-analyses/<id>/` become `{request.md, analysis.md, slides.md, metadata.json}` (was 3 keys, now 4).
- `storage/src/competitive-analyses.ts` canonical helpers extended for slides.md read/write. No semantic change to metadata.
- List tool output unchanged structurally; `analysesMarkdown` remains presentation-only and unaffected.
- AGENTS.md updates required (binding contract):
  - "PM analyses and reports" section: change persisted key set `competitive-analyses/<analysisId>/{request.md,analysis.md,metadata.json}` to include `slides.md`.
  - Add invariant: every complete competitive save must produce slides.md.
  - Add `/reports/competitive/<id>/slides` to the route list.
- `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md` updated to match (AGENTS.md says docs must follow).

## Client layer

### New dependency

- Add `@marp-team/marp-core` to `client/package.json`. Browser-safe, no Chromium required for HTML rendering.

### New route

`client/src/app/reports/competitive/[analysisId]/slides/page.tsx`:

- Server component, `export const dynamic = 'force-dynamic'`.
- Same identity seam (`CHEKKU_LOCAL_USER_ID`).
- Calls existing `getCompetitiveAnalysisForUser(analysisId)` from `client/src/server/competitive-analyses.ts`.
- 404 (`notFound()`) when analysis missing OR `slidesMarkdown` empty.
- Passes `slidesMarkdown` and `analysisId` to client component.
- Renders inside `studio-shell` + `StudioNav` for visual continuity.

### New client component

`client/src/components/competitive-slides.tsx`:

- `'use client'`.
- Props: `{ slidesMarkdown: string; analysisId: string }`.
- `useEffect` once on mount:
  - `const { Marp } = await import('@marp-team/marp-core')`.
  - `const { html, css } = new Marp().render(slidesMarkdown)`.
  - `setRendered({ html, css })`.
- Render:
  - One `<style dangerouslySetInnerHTML={{ __html: css }} />`.
  - One `<div dangerouslySetInnerHTML={{ __html: html }} />` inside a scoped wrapper class `competitive-slides-stage`.
- Print button (fixed top-right): `onClick={() => window.print()}`.
- Keyboard nav: ArrowRight/ArrowLeft scroll to next/prev slide anchor. (Marp output uses `id="marp-N"` per slide; scroll into view.)
- Loading state: simple spinner text "Rendering deck…" while `rendered` is null.
- Error state: if dynamic import or render throws, render fixed safe error "Could not render slides." and the analysis detail link.

### Print CSS

Append `@media print` block to `client/src/app/studio.css`:

- Hide `studio-nav`, buttons, headers, page chrome.
- Each `<div id="marp-N">` becomes one printed page via `break-after: page`.
- `@page { size: 1280px 720px; margin: 0; }`.

### Link surfacing

Three placements, all cheap:

1. **Chat**: agent emits Markdown link in final response (skill rule above). `MarkdownMessage` already auto-links relative URLs.
2. **Detail page** (`client/src/app/reports/competitive/[analysisId]/page.tsx`): add a `View slides` button in the `studio-report-header` next to the existing `Back to analyses` button.
3. **Card grid** (`client/src/app/reports/competitive/page.tsx`): add a `Slides` badge or glyph to each card.

## Identity and access

- Unchanged from current `/reports/*` posture. Server-rendered behind `CHEKKU_LOCAL_USER_ID`. Local-only.
- Browser modules never import `@chekku/storage`. All reads via the existing server seam (`/api/storage/competitive-analyses/*`).
- No new public route. No new auth surface.

## Failure behavior

- **Analysis save succeeds but slides Markdown absent**: rejected before save by tool input validation. Save not attempted; agent must retry the draft or treat as incomplete.
- **Analysis incomplete**: existing incomplete branch unchanged. No `slides.md` written, no `View slides` link emitted.
- **Slides route hit with no `slides.md` persisted** (e.g. legacy analysis saved before this feature): route returns 404.
- **Marp render throws in browser**: client component shows fixed safe error plus link back to analysis detail.
- **Marp Core dynamic import fails**: same fixed safe error path.

## Testing

Regression and new tests:

- **Agent skill** (`agent/src/agents/__tests__/pm-agent-skills.test.ts` or similar): assert instructions contain the slide-deck rules and the `View slides:` emission requirement.
- **Save tool** (`agent/src/mastra/tools/competitive-analysis-tools.test.ts`):
  - assert `slidesMarkdown` is required for complete save;
  - assert save writes `slides.md` alongside existing keys;
  - assert list/view tool outputs continue to expose `slidesMarkdown` as a presentation-only field (not in persisted metadata).
- **Both-agents test** (`agent/src/agents/__tests__/both-agents.test.ts`): add substring assertion for `View slides:` in PM Agent instructions.
- **Storage**: canonical helper writes/reads the 4-key set; noncanonical keys still skipped by list.
- **Client route** (new test file alongside existing route tests):
  - server returns 404 when analysis missing;
  - server returns 404 when `slidesMarkdown` empty;
  - server passes `slidesMarkdown` to client component otherwise.
- **Client component** (jsdom test, same pattern as `command-menu.test.tsx`):
  - mocks `@marp-team/marp-core` render output;
  - asserts Print button calls `window.print`;
  - asserts keyboard handlers attached.
- **UI structure** (`client/src/lib/ui-structure.test.ts`): allow the new slides route and component.
- **AGENTS.md / docs**: spot-check that persisted-key list and routes list include slides.md and the slides route.

Full repo verification:

```bash
npm run check
npm run build
git diff --check
```

## Out of scope (v2 follow-ups)

- PPTX export via server-side Chromium / Playwright.
- Public unauthenticated sharing via `/public/slides/<id>`.
- Signed-URL sharing with expiry.
- Custom brand theming (logo, colors, fonts).
- Weekly report slides (same pattern, separate skill).
- Slide editing UI.
- Speaker notes.

## Risks and notes

- **Token cost**: each competitive run adds ~1-3k output tokens for the slide draft. Accepted by design choice (auto-on-save).
- **Marp bundle**: ~600KB JS. Mitigated by dynamic `import()` inside the client component so only the `/slides` route pays.
- **Slide overflow**: dense sections (Feature Matrix) may overflow the 1280x720 canvas. Mitigated by skill instruction to split or switch to `4:3` per slide; Marp core's auto-scaling handles the rest.
- **AGENTS.md is the binding contract**: changes here must land in the same PR or the build breaks downstream tests.
- **Unchanged invariants**: complete-only save, canonical `pca_` IDs, relative key set, no `pm` semantics in Garage MCP, browser modules never import `@chekku/storage`. (Note: the research budget was raised from 5/8/1 to 8/14/1 mid-implementation by commit `40767bb` to give the alternate-URL retry logic room to fire on high-failure runs; AGENTS.md / README / OPERATIONS / ARCHITECTURE reflect the new caps, and `maxSteps` went 18 → 25 to fit the extra tool calls.)
