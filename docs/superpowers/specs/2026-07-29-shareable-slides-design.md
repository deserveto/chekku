# Shareable Slides + Viewer Overhaul

## Goal

Fix two print regressions in the slides viewer, add fullscreen + slide-counter UX, and add token-gated public sharing so a competitive analysis deck can be viewed by anyone with a share link (no Chekku account required).

## Scope

**v1.1 (this spec)**:

- Fix print clip bug (only first page renders) and toolbar-leak bug (app chrome appears in printed output).
- Fullscreen mode (Fullscreen API + Esc to exit).
- Slide counter (e.g., `3 / 12`) that updates as the user scrolls.
- Token-gated public sharing:
  - On-demand token creation via authenticated `Create share link` button on the analysis detail page.
  - New persisted sibling key `share-token.json` per analysis (when shared).
  - New unauthenticated route `/public/slides/<id>?t=<token>` that reads only `share-token.json` and `slides.md`.

**Deferred (v2)**:

- Token revocation flow (`DELETE /share` + revoke button).
- Token expiry.
- Per-analysis audit log (who opened the share link).
- Custom brand theming for public decks.
- Presenter mode (current + next + notes).
- Mobile touch/swipe nav (defer until tested — Marp's scroll-snap may already work).
- Signed-URL sharing with expiry (overkill for this use case).

## Architecture

```
AUTHENTICATED (existing identity seam)        UNAUTHENTICATED (new public seam)
─────────────────────────────────────────    ─────────────────────────────────────────
/reports/competitive/<id>                    /public/slides/<id>?t=<token>
  detail page                                  public deck view
  [Create share link] button ──┐                ↑ token validated server-side
                                │                ↑ reads ONLY share-token.json + slides.md
POST /api/storage/              │               no analysis.md, no metadata.json,
  competitive-analyses/<id>/    │               no other Garage keys
  share                         │
  ↑ creates share-token.json,   │
    returns URL                 │
                                │
/reports/competitive/<id>/slides ←───── same component (CompetitiveSlides) but
  existing authenticated viewer       stripped chrome on public route
```

## Storage layer

- **New sibling key**: `competitive-analyses/<id>/share-token.json` containing `{ token: <32-hex>, createdAt: <ISO>, anchorProduct: <string> }`. The `anchorProduct` is captured from `metadata.json` at share-link creation time (the only step that reads metadata) and frozen into the share-token bundle, so the public read path never touches metadata. Created on-demand only when the user clicks `Create share link`. Absent for analyses that have never been shared.
- **`metadata.json` shape unchanged**. The share token does NOT live in metadata.
- `competitiveAnalysisKeysFor(id)` gains `shareTokenObjectKey: competitive-analyses/<id>/share-token.json`.
- New helpers in `storage/src/competitive-analyses.ts`:
  - `createShareToken(store, analysisId, anchorProduct): Promise<{ token: string; createdAt: string; anchorProduct: string }>` — idempotent. Reads existing token first; returns it as-is if already set. Creates new token only when none exists. Idempotency prevents token rotation from repeated button clicks.
  - `getShareToken(store, analysisId): Promise<{ token: string; createdAt: string } | undefined>` — returns `undefined` when no token file exists. Throws `ObjectStorageError` for any non-`not-found` storage error (so route returns 503, not 404, on outage).
  - `getShareableSlides(store, analysisId, token): Promise<{ anchorProduct: string; createdAt: string; slidesMarkdown: string } | undefined>` — single-call helper used by the public route. Reads `share-token.json`, validates token matches (constant-time compare), reads `slides.md`. Returns `undefined` if token missing/mismatched or slides missing. Throws on storage errors.
- Token generation: `crypto.randomBytes(16).toString('hex')` (32 hex chars, 128 bits of entropy).
- `share-token.json` shape is NOT validated through the metadata projection pipeline — it is a standalone JSON object, not part of analysis metadata. Read path validates shape defensively and returns `undefined` on any parse error.

## Authenticated server routes (new)

### `POST /api/storage/competitive-analyses/[analysisId]/share`

- Identity-seamed: calls a new `createShareLinkForUser(analysisId)` server seam that requires `CHEKKU_LOCAL_USER_ID`.
- Same safe-error pattern as existing competitive-analyses routes: 403 forbidden, 400 invalid-analysis-id, 404 not-found, 503 storage-unavailable.
- Returns `{ url: '/public/slides/<id>?t=<token>' }` on success.
- Request body: empty. The route takes only the path parameter.

### `client/src/server/competitive-analyses.ts` (extended)

- New `createShareLinkForUser(analysisId, dependencies?)` function. Same pattern as `getCompetitiveAnalysisForUser` — identity check first, then delegate to storage.
- New `getPublicSlides(analysisId, token, dependencies?)` function. **No identity check.** Reads only `share-token.json` + `slides.md` via the new storage helper. Returns either the public payload or throws `CompetitiveAnalysisServiceError` with `not-found` code (404).

## Public route (new)

`client/src/app/public/slides/[analysisId]/page.tsx`:

- Server component, **unauthenticated**. NO `requireIdentity()` call.
- Reads `?t=<token>` search params via Next.js 15+ async `searchParams`.
- Canonical-id regex check on path `analysisId` first (rejects malformed IDs early).
- Calls `getPublicSlides(analysisId, token)`. On `undefined` or service error → `notFound()` (404). Deliberately does NOT distinguish wrong-token from missing-analysis (both 404).
- Renders `<CompetitiveSlides variant="public" analysisId={...} slidesMarkdown={...} anchorProduct={...} createdAt={...} />`.
- No `StudioNav`. No header actions. No app chrome. Just the deck + a one-line footer ("Generated by Chekku · <createdAt>").

## Viewer overhaul (`client/src/components/competitive-slides.tsx`)

### Bug fixes

1. **Print clip** — remove `overflow: hidden` from `.competitive-slides-stage` (in `client/src/app/studio.css`). Marp's own CSS handles scroll-snap during screen use and pagination during print. The `overflow: hidden` clips everything below the first slide when paginated.
2. **Toolbar leak in print** — inject a scoped `<style>` block in the component (NOT in `studio.css`) with `@media print { .competitive-slides-toolbar, .competitive-slides-counter, footer { display: none } }`. Only this route pays.

### New features

3. **Fullscreen** — Fullscreen API on the stage container (`element.requestFullscreen()`). Browser-native Esc to exit. Toolbar button toggles between `Fullscreen` and `Exit fullscreen` based on `fullscreenchange` events.
4. **Slide counter** — `IntersectionObserver` on slide SVGs (`svg[data-marpit-svg]`). Tracks current slide index. State `{ current, total }` displayed in toolbar as `N / M`. Auto-updates as user scrolls or uses keyboard nav.
5. **Public mode prop** — `CompetitiveSlides` accepts `variant: 'authenticated' | 'public'` (default `'authenticated'`). Public variant:
   - Hides toolbar (no Print/Fullscreen buttons).
   - Keeps keyboard nav (the page IS the deck, nothing else to hijack).
   - Renders footer: `Generated by Chekku · <createdAt>`.

### Props shape (updated)

```ts
interface CompetitiveSlidesProps {
  analysisId: string;
  slidesMarkdown: string;
  variant?: 'authenticated' | 'public'; // default 'authenticated'
  anchorProduct?: string;               // required for public variant footer
  createdAt?: string;                   // required for public variant footer
}
```

## UI flow

### Detail page (`/reports/competitive/[id]`)

- Existing `View slides` button stays.
- New `Create share link` button next to it:
  - On click: POST `/api/storage/competitive-analyses/<id>/share`.
  - On success: copy returned URL to clipboard (`navigator.clipboard.writeText`), button text changes to `Copy share link` for subsequent clicks (re-uses the cached URL), show a toast/inline message `Share link copied`.
  - On error: inline message `Could not create share link`.
- Implementation: small client component (`ShareLinkButton`) wrapping the button + fetch + clipboard logic.

### Slides viewer (`/reports/competitive/<id>/slides`)

- Toolbar: `[Print] [Fullscreen]  N / M`
- Optional v1.2: `Share` button if a share token exists (calls the same GET to retrieve). For v1.1, the share affordance lives on the detail page only.

### Public viewer (`/public/slides/<id>?t=<token>`)

- No toolbar. Just the deck. Footer: `Generated by Chekku · <createdAt>`.

## Identity and access

- Authenticated routes use the existing `CHEKKU_LOCAL_USER_ID` seam (unchanged).
- Public route is intentionally unauthenticated — no identity check.
- **Hard invariant**: the public server seam reads ONLY `share-token.json` and `slides.md`. It must NEVER call `getCompetitiveAnalysis` or read `metadata.json`, `analysis.md`, `request.md`, or any other Garage key. A ui-structure test locks this.
- Token mismatch vs missing analysis vs missing slides all return 404 — no oracle for "does this analysis exist".

## Failure behavior

- **Token missing** (analysis never shared) → public route 404.
- **Token mismatch** → public route 404 (same response shape as missing).
- **slides.md missing** (analysis shared but slides deleted somehow) → public route 404.
- **Storage outage** reading share-token.json or slides.md → public route 503 via `CompetitiveAnalysisServiceError`.
- **Share-token.json malformed** (corrupted) → treat as missing, return 404. Logged server-side.
- **Authenticated share-link create fails** → 503 (or 404 if analysis unknown). Inline error on detail page.

## Testing

Regression and new tests:

- **Storage** (`storage/src/competitive-analyses.test.ts`):
  - `createShareToken` is idempotent (returns same token on second call, doesn't rotate).
  - `createShareToken` writes share-token.json with `{ token, createdAt }` shape.
  - `getShareToken` returns undefined when no file; returns parsed payload when present; throws on non-not-found errors.
  - `getShareableSlides` returns undefined for missing token, mismatched token, missing slides; returns `{ anchorProduct, createdAt, slidesMarkdown }` for valid combination.
  - `getShareableSlides` throws on storage outage (not 404-masked).
- **Server seam** (`client/src/server/competitive-analyses.test.ts`):
  - `createShareLinkForUser` requires identity; returns URL shape.
  - `getPublicSlides` does NOT require identity; returns 404 for missing/mismatched; returns payload for valid.
- **Share API route** (new test alongside existing route tests):
  - 403 without identity.
  - 404 for unknown analysis.
  - 200 + `{ url }` on success.
- **Public route** (new test):
  - 404 for missing token.
  - 404 for wrong token.
  - 404 for malformed analysis ID.
  - Renders deck for valid token; does NOT render analysis markdown or metadata.
- **Viewer component** (`competitive-slides.test.tsx` extended):
  - Fullscreen button calls `requestFullscreen` on the stage element (mock).
  - `IntersectionObserver` mock drives counter updates (`current` changes).
  - Public variant: toolbar absent, footer present.
- **UI structure** (`client/src/lib/ui-structure.test.ts`):
  - Public route imports `CompetitiveSlides` and `getPublicSlides` only.
  - Public route does NOT import `@chekku/storage`, does NOT import `getCompetitiveAnalysisForUser`.
- **AGENTS.md / docs**: spot-check that persisted-key set, route list, and public-seam invariant are documented.

Full repo verification:

```bash
npm run check
npm run build
git diff --check
```

## Out of scope (v2 follow-ups)

- Token revocation (`DELETE /share` + revoke button).
- Token expiry.
- Per-analysis audit log.
- Custom brand theming for public decks.
- Presenter mode.
- Mobile touch/swipe nav.
- Signed-URL sharing.

## Risks and notes

- **Public route is a new auth boundary.** Hard rule: server seam reads ONLY the two allowed keys. Any drift = leak. The ui-structure test locks this; reviewer should also confirm during PR review.
- **Token brute-force**: 32 hex chars = 128 bits of entropy. Not feasible to guess.
- **Token-in-URL leakage**: tokens leak via Referer headers, browser history, server logs. Acceptable for this use case (decks are non-sensitive competitive analysis). Documented; user-facing warning on the `Create share link` toast.
- **AGENTS.md updates required** (binding contract): new public route, new persisted key (`share-token.json`), new public-seam invariant, public-route no-auth rule, public-route read-allowlist (share-token.json + slides.md only).
- **Print fix verification**: removing `overflow: hidden` from `.competitive-slides-stage` is a one-line CSS change. Marp's own print CSS handles the rest. Must verify with an actual print-preview smoke test before merge (manual).
- **Full-mode + Marp CSS**: Marp's CSS sets each slide SVG to `height: 100vh; width: 100vw`. In fullscreen, the stage container fills the screen and each slide SVG fills the viewport. Should work without additional CSS.
- **Unchanged invariants**: complete-only save, canonical `pca_` IDs, relative key set, browser modules never import `@chekku/storage`, no `pm` semantics in Garage MCP, identity seam for authenticated routes.
