# Competitive Analysis Marp Slides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-produce a Marp slide deck (`slides.md`) as part of every complete competitive-analysis save, expose it at `/reports/competitive/<id>/slides`, and render it in-app with print-to-PDF.

**Architecture:** Storage gains a 4th persisted sibling key (`slides.md`). The agent save tool requires a non-blank `slidesMarkdown` field for complete saves; the view tool and server seam expose it. A new client route renders the deck via lazy-loaded `@marp-team/marp-core`. Three surfaces (chat link, detail page button, card grid badge) promote the new route.

**Tech Stack:** TypeScript, Mastra, Zod, Next.js (App Router), `@marp-team/marp-core`, Vitest, jsdom.

## Global Constraints

- Persisted relative keys for one analysis: `competitive-analyses/<id>/{request.md, analysis.md, slides.md, metadata.json}`. Was 3 keys, now 4.
- `slides.md` is required for every NEW complete save (non-blank, ≤262,144 UTF-8 bytes). Legacy analyses saved before this feature have no `slides.md`; reads return `slidesMarkdown: undefined` and the slides route returns 404.
- `metadata.json` shape is unchanged. Presence of `slides.md` is the slides-available signal.
- Browser modules never import `@chekku/storage`. All Garage access goes through `client/src/server/competitive-analyses.ts`.
- All persisted keys remain relative (`competitive-analyses/<id>/...`). Never leak physical `agents/<base64url-agent-id>/...` prefixes.
- Canonical analysis IDs stay `^pca_[0-9]{14}_[0-9a-f]{8}$`.
- No public sharing, no PPTX, no Chromium server-side in v1.
- `npm run check` and `npm run build` must pass after each task.

---

## File Structure

**Created:**
- `client/src/app/reports/competitive/[analysisId]/slides/page.tsx` — server component, identity seam, fetches analysis, 404s when slides absent.
- `client/src/app/reports/competitive/[analysisId]/slides/page.test.ts` — renderToStaticMarkup test mirroring `competitive-pages.test.ts`.
- `client/src/components/competitive-slides.tsx` — `'use client'`, lazy Marp render, print, keyboard nav.
- `client/src/components/competitive-slides.test.tsx` — jsdom test mirroring `command-menu.test.tsx`, mocks `@marp-team/marp-core`.

**Modified:**
- `storage/src/competitive-analyses.ts` — `competitiveAnalysisKeysFor` gains `slidesObjectKey`; `SaveCompetitiveAnalysisInput` gains `slidesMarkdown`; `CompetitiveAnalysisReadResult` gains optional `slidesMarkdown?`; `saveCompetitiveAnalysis` writes `slides.md`; `getCompetitiveAnalysis` reads `slides.md` defensively.
- `storage/src/competitive-analyses.test.ts` — update assertions for the new key + slides round-trip + legacy-missing read.
- `agent/src/mastra/tools/competitive-analysis-tools.ts` — `saveInputSchema` gains required `slidesMarkdown`; view tool output gains `slidesMarkdown`; save execute passes it through.
- `agent/src/mastra/tools/competitive-analysis-tools.test.ts` — update `saveInput` fixture and assertions.
- `agent/src/agents/pm-agent-skills.ts` — append `## Slide deck` section to `competitiveAnalysisInstructions`; add `View slides:` emission rule.
- `agent/src/agents/__tests__/pm-agent-skills.test.ts` — assert new slide substrings.
- `agent/src/agents/__tests__/both-agents.test.ts` — assert `View slides:` substring in PM Agent instructions.
- `client/package.json` — add `@marp-team/marp-core` to dependencies.
- `client/src/app/reports/competitive/[analysisId]/page.tsx` — add `View slides` button in `studio-report-header`.
- `client/src/app/reports/competitive/page.tsx` — add `Slides` badge to each card.
- `client/src/app/reports/competitive/competitive-pages.test.ts` — extend fixtures to include `slidesMarkdown`; assert View slides link in detail render; assert badge in list render.
- `client/src/app/studio.css` — append `.competitive-slides-stage` and `@media print` rules.
- `client/src/lib/ui-structure.test.ts` — add slides route to optional sources; assert slides route does not import `@chekku/storage`; assert slides route imports `CompetitiveSlides`.
- `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` — persisted-key set, routes list, new invariant.

---

## Task 1: Storage — slides.md key, save, defensive read

**Files:**
- Modify: `storage/src/competitive-analyses.ts`
- Test: `storage/src/competitive-analyses.test.ts`

**Interfaces:**
- Produces: `competitiveAnalysisKeysFor(id).slidesObjectKey` returns `competitive-analyses/<id>/slides.md`. `SaveCompetitiveAnalysisInput` gains required `slidesMarkdown: string`. `CompetitiveAnalysisReadResult` gains `slidesMarkdown?: string`.

- [ ] **Step 1: Update `competitiveAnalysisKeysFor` to include `slidesObjectKey`**

In `storage/src/competitive-analyses.ts`, replace the function:

```ts
export function competitiveAnalysisKeysFor(analysisId: string) {
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new Error(`Invalid competitive analysis id: ${analysisId}`);
  }
  const base = `competitive-analyses/${analysisId}`;
  return {
    requestObjectKey: `${base}/request.md`,
    analysisObjectKey: `${base}/analysis.md`,
    slidesObjectKey: `${base}/slides.md`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}
```

- [ ] **Step 2: Extend `SaveCompetitiveAnalysisInput` and `CompetitiveAnalysisReadResult` interfaces**

```ts
export interface SaveCompetitiveAnalysisInput {
  store: ObjectStorage;
  requestMarkdown: string;
  analysisMarkdown: string;
  slidesMarkdown: string;
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
  slidesMarkdown?: string;
  metadata: CompetitiveAnalysisMetadata;
}
```

- [ ] **Step 3: Write failing test — `slides.md` is persisted between analysis and metadata**

Append to `storage/src/competitive-analyses.test.ts` inside the `describe('competitive analysis storage', ...)` block, before the closing `});`:

```ts
const slidesMarkdown = '---\nmarp: true\n---\n# Deck\n';

function validInputWithSlides(store: ObjectStorage) {
  return { ...validInput(store), slidesMarkdown };
}

it('writes slides.md between analysis.md and metadata.json', async () => {
  const { storage, writes } = createMemoryStorage();

  await saveCompetitiveAnalysis({ ...validInput(storage), slidesMarkdown });

  expect(writes.map(({ key }) => key)).toEqual([
    `competitive-analyses/${analysisId}/request.md`,
    `competitive-analyses/${analysisId}/analysis.md`,
    `competitive-analyses/${analysisId}/slides.md`,
    `competitive-analyses/${analysisId}/metadata.json`,
  ]);
  expect(writes[2]).toMatchObject({
    key: `competitive-analyses/${analysisId}/slides.md`,
    value: slidesMarkdown,
    contentType: 'text/markdown',
  });
});

it('rejects blank slidesMarkdown before writing anything', async () => {
  const { storage, writes } = createMemoryStorage();

  await expect(saveCompetitiveAnalysis({ ...validInput(storage), slidesMarkdown: '   ' })).rejects.toThrow();
  expect(writes).toEqual([]);
});

it('rejects oversized slidesMarkdown before writing', async () => {
  const { storage, writes } = createMemoryStorage();

  await expect(saveCompetitiveAnalysis({
    ...validInput(storage),
    slidesMarkdown: 's'.repeat(262_145),
  })).rejects.toThrow();
  expect(writes).toEqual([]);
});

it('round-trips slidesMarkdown on read', async () => {
  const { storage } = createMemoryStorage();
  const store = createCompetitiveAnalysisStorage(storage);

  await saveCompetitiveAnalysis({ ...validInput(store), slidesMarkdown });

  await expect(getCompetitiveAnalysis(store, analysisId)).resolves.toMatchObject({
    slidesMarkdown,
  });
});

it('returns slidesMarkdown undefined for legacy analyses without slides.md', async () => {
  const { objects, storage } = createMemoryStorage();
  const keys = competitiveAnalysisKeysFor(analysisId);
  const approved = {
    analysisId,
    createdAt: '2026-07-23T12:00:00.000Z',
    anchorProduct: 'GPT',
    competitorNames,
    productCount: 6,
    sourceCount: 6,
    ...keys,
  };
  objects.set(keys.requestObjectKey, requestMarkdown);
  objects.set(keys.analysisObjectKey, analysisMarkdown);
  objects.set(keys.metadataObjectKey, JSON.stringify(approved));

  await expect(getCompetitiveAnalysis(storage, analysisId)).resolves.toMatchObject({
    slidesMarkdown: undefined,
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run storage/src/competitive-analyses.test.ts`
Expected: FAIL with errors on the new tests (blank/oversized rejected differently, slides.md not written, slidesMarkdown undefined on read mismatched).

- [ ] **Step 5: Update `saveCompetitiveAnalysis` to validate and write slides.md**

In `storage/src/competitive-analyses.ts`, replace the `saveCompetitiveAnalysis` function body. The function now validates `slidesMarkdown` (reusing the existing `validateMarkdown` helper), writes it between `analysis.md` and `metadata.json`:

```ts
export async function saveCompetitiveAnalysis(
  input: SaveCompetitiveAnalysisInput,
): Promise<CompetitiveAnalysisMetadata> {
  validateMarkdown(input.requestMarkdown, 'requestMarkdown');
  validateMarkdown(input.analysisMarkdown, 'analysisMarkdown');
  validateMarkdown(input.slidesMarkdown, 'slidesMarkdown');
  const products = normalizeProducts(input.anchorProduct, input.competitorNames);
  const market = input.market === undefined
    ? undefined
    : normalizeBoundedText(input.market, 'market', MAX_MARKET_BYTES);
  const productCount = products.competitorNames.length + 1;
  if (!Number.isInteger(input.sourceCount) || input.sourceCount !== productCount) {
    throw new Error('sourceCount must equal the number of analyzed products');
  }

  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const analysisId = input.analysisId ?? createCompetitiveAnalysisId(new Date(createdAt));
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const metadata: CompetitiveAnalysisMetadata = {
    analysisId,
    createdAt,
    anchorProduct: products.anchorProduct,
    ...(market === undefined ? {} : { market }),
    competitorNames: products.competitorNames,
    productCount,
    sourceCount: productCount,
    requestObjectKey: objectKeys.requestObjectKey,
    analysisObjectKey: objectKeys.analysisObjectKey,
    metadataObjectKey: objectKeys.metadataObjectKey,
  };

  await input.store.createText(objectKeys.requestObjectKey, input.requestMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.analysisObjectKey, input.analysisMarkdown, 'text/markdown');
  await input.store.createText(objectKeys.slidesObjectKey, input.slidesMarkdown, 'text/markdown');
  await input.store.createText(
    objectKeys.metadataObjectKey,
    JSON.stringify(metadata, null, 2),
    'application/json',
  );
  return metadata;
}
```

**CRITICAL:** `metadata.json` is still last. The `metadata` interface does NOT gain `slidesObjectKey` as a persisted field. Pick the three metadata keys explicitly (do NOT spread `...objectKeys` — it now contains `slidesObjectKey`, which would leak into persisted metadata, violate the "metadata shape unchanged" invariant, and trip the agent-side `.strict()` `metadataSchema` validation).

- [ ] **Step 6: Update `getCompetitiveAnalysis` to defensively read slides.md**

```ts
export async function getCompetitiveAnalysis(
  store: ObjectStorage,
  analysisId: string,
): Promise<CompetitiveAnalysisReadResult> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const [requestMarkdown, analysisMarkdown, metadataText] = await Promise.all([
    store.getText(objectKeys.requestObjectKey),
    store.getText(objectKeys.analysisObjectKey),
    store.getText(objectKeys.metadataObjectKey),
  ]);

  let slidesMarkdown: string | undefined;
  try {
    slidesMarkdown = await store.getText(objectKeys.slidesObjectKey);
  } catch {
    slidesMarkdown = undefined;
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error(`Invalid competitive analysis metadata for ${analysisId}`);
  }
  const parsed = parseCompetitiveAnalysisMetadata(metadata);
  if (!parsed || parsed.analysisId !== analysisId) {
    throw new Error(`Invalid competitive analysis metadata for ${analysisId}`);
  }
  return { analysisId, requestMarkdown, analysisMarkdown, slidesMarkdown, metadata: parsed };
}
```

- [ ] **Step 7: Update existing storage tests for the new key + slidesMarkdown input**

The existing tests in `storage/src/competitive-analyses.test.ts` use `validInput(store)` which does not include `slidesMarkdown`. They will now fail typecheck. Update `validInput`:

```ts
function validInput(store: ObjectStorage) {
  return {
    store,
    requestMarkdown,
    analysisMarkdown,
    slidesMarkdown: '---\nmarp: true\n---\n# Deck\n',
    anchorProduct: 'GPT',
    market: 'General AI assistants',
    competitorNames,
    sourceCount: 6,
    analysisId,
    now: () => new Date('2026-07-23T12:00:00.000Z'),
  };
}
```

Also update the `writes through the PM namespace and round-trips approved fields` test — the persisted keys list now includes `slides.md`:

```ts
expect(writes.map(({ key }) => key)).toEqual([
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/request.md`,
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/analysis.md`,
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/slides.md`,
  `agents/cG0tYWdlbnQ/competitive-analyses/${analysisId}/metadata.json`,
]);
```

That same test's `expect(metadata).toEqual({...competitiveAnalysisKeysFor(analysisId)})` spread must also be replaced — `competitiveAnalysisKeysFor` now returns 4 keys but persisted metadata keeps 3. Use explicit three-key listing plus a defensive guard:

```ts
expect(metadata).toEqual({
  analysisId,
  createdAt: '2026-07-23T12:00:00.000Z',
  anchorProduct: 'GPT',
  market: 'General AI assistants',
  competitorNames,
  productCount: 6,
  sourceCount: 6,
  requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
  analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
  metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
});
expect(metadata).not.toHaveProperty('slidesObjectKey');
```

And the `writes request and analysis before metadata using createText` test — add slides.md between analysis.md and metadata.json:

```ts
expect(writes).toEqual([
  {
    method: 'create',
    key: `competitive-analyses/${analysisId}/request.md`,
    value: requestMarkdown,
    contentType: 'text/markdown',
  },
  {
    method: 'create',
    key: `competitive-analyses/${analysisId}/analysis.md`,
    value: analysisMarkdown,
    contentType: 'text/markdown',
  },
  {
    method: 'create',
    key: `competitive-analyses/${analysisId}/slides.md`,
    value: '---\nmarp: true\n---\n# Deck\n',
    contentType: 'text/markdown',
  },
  {
    method: 'create',
    key: `competitive-analyses/${analysisId}/metadata.json`,
    value: JSON.stringify(metadata, null, 2),
    contentType: 'application/json',
  },
]);
```

Also update the `propagates %s write failures` test param list to include `'slides.md'`:

```ts
it.each([
  ['analysis.md', [`competitive-analyses/${analysisId}/request.md`]],
  ['slides.md', [
    `competitive-analyses/${analysisId}/request.md`,
    `competitive-analyses/${analysisId}/analysis.md`,
  ]],
  ['metadata.json', [
    `competitive-analyses/${analysisId}/request.md`,
    `competitive-analyses/${analysisId}/analysis.md`,
    `competitive-analyses/${analysisId}/slides.md`,
  ]],
])('propagates %s write failures without exposing complete metadata', async (failedObject, persistedKeys) => {
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run storage/src/competitive-analyses.test.ts`
Expected: PASS (all 18+ tests including 5 new).

- [ ] **Step 9: Commit**

```bash
git add storage/src/competitive-analyses.ts storage/src/competitive-analyses.test.ts
git commit -m "feat(storage): persist slides.md alongside competitive analysis"
```

---

## Task 2: Agent save/view tool — slidesMarkdown schema + execute

**Files:**
- Modify: `agent/src/mastra/tools/competitive-analysis-tools.ts`
- Test: `agent/src/mastra/tools/competitive-analysis-tools.test.ts`

**Interfaces:**
- Consumes: `saveCompetitiveAnalysis` from `@chekku/storage` now requires `slidesMarkdown`.
- Produces: `saveInputSchema` requires `slidesMarkdown: string` (non-blank, ≤262,144 bytes). View tool output schema gains `slidesMarkdown: z.string()`.

- [ ] **Step 1: Write failing test — save requires slidesMarkdown**

In `agent/src/mastra/tools/competitive-analysis-tools.test.ts`, extend the existing `saveInput` fixture near the top of the file:

```ts
const slidesMarkdown = [
  '---',
  'marp: true',
  'theme: default',
  'paginate: true',
  'size: 16:9',
  '---',
  '',
  '# Competitive Analysis: GPT',
  '',
  '## Agenda',
  '',
  '- Executive summary',
  '- Sources',
  '',
  '---',
  '',
  '## Sources',
  '',
  '- GPT: https://openai.com/chatgpt/',
].join('\n');

const saveInput = {
  requestMarkdown: '/competitive-analysis GPT vs Claude',
  analysisMarkdown,
  slidesMarkdown,
  anchorProduct: ' GPT ',
  market: ' AI assistants ',
  competitorNames,
  sources,
};
```

Then add a new test inside the `describe('competitive analysis tools', ...)` block, near the other `it.each` rejection cases:

```ts
it.each([
  ['blank slides', { slidesMarkdown: ' \r\n\t' }],
  ['oversized slides', { slidesMarkdown: 's'.repeat(262_145) }],
])('rejects incomplete slidesMarkdown save input: %s', async (_name, override) => {
  const validation = await validateInput(
    createSaveCompetitiveAnalysisToGarageTool(),
    { ...saveInput, ...override },
  );

  expect(validation.issues).toBeDefined();
});
```

Also extend the existing `'saves normalized complete analyses under the fixed PM namespace'` test to assert slides.md is persisted:

```ts
expect(objects.get(`${base}/slides.md`)).toBe(saveInput.slidesMarkdown);
```

Also extend the `'views request, analysis, and projected metadata without presentation fields'` test to assert slidesMarkdown flows through the view tool output:

```ts
expect(viewed).toMatchObject({
  analysisId: saved.analysisId,
  requestMarkdown: saveInput.requestMarkdown,
  analysisMarkdown: saveInput.analysisMarkdown,
  slidesMarkdown: saveInput.slidesMarkdown,
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run agent/src/mastra/tools/competitive-analysis-tools.test.ts`
Expected: FAIL — `slidesMarkdown` not in schema, save execute breaks, view output missing field.

- [ ] **Step 3: Add `slidesMarkdown` to `saveInputSchema`**

In `agent/src/mastra/tools/competitive-analysis-tools.ts`, the `saveInputSchema` definition gains the new field. The schema reuses `markdownSchema` (already defined above):

```ts
const saveInputSchema = z.object({
  requestMarkdown: markdownSchema,
  analysisMarkdown: markdownSchema,
  slidesMarkdown: markdownSchema,
  anchorProduct: nameSchema,
  market: boundedTrimmedString(MAX_MARKET_BYTES).optional(),
  competitorNames: z.array(nameSchema).min(5).max(7),
  sources: z.array(sourceSchema).min(6).max(8),
}).strict().superRefine((input, context) => {
```

(rest of `superRefine` body unchanged)

- [ ] **Step 4: Update save tool `execute` to pass `slidesMarkdown` through**

```ts
execute: async (rawInput) => {
  const input = saveInputSchema.parse(rawInput);
  const store = competitiveAnalysisStore(options);
  await store.ensureReady?.();
  return saveCompetitiveAnalysis({
    store,
    requestMarkdown: input.requestMarkdown,
    analysisMarkdown: input.analysisMarkdown,
    slidesMarkdown: input.slidesMarkdown,
    anchorProduct: input.anchorProduct,
    ...(input.market === undefined ? {} : { market: input.market }),
    competitorNames: input.competitorNames,
    sourceCount: input.sources.length,
    ...(options.now ? { now: options.now } : {}),
  });
},
```

- [ ] **Step 5: Add `slidesMarkdown` to view tool output schema and rely on `getCompetitiveAnalysis` from `@chekku/storage`**

```ts
export function createViewCompetitiveAnalysisFromGarageTool(
  options: CompetitiveAnalysisToolOptions = {},
) {
  return createTool({
    id: 'view_competitive_analysis_from_garage',
    description: 'View a saved PM competitive analysis from Garage by analysis id.',
    inputSchema: z.object({
      analysisId: z.string().regex(/^pca_[0-9]{14}_[0-9a-f]{8}$/),
    }).strict(),
    outputSchema: z.object({
      analysisId: z.string(),
      requestMarkdown: z.string(),
      analysisMarkdown: z.string(),
      slidesMarkdown: z.string(),
      metadata: metadataSchema,
    }).strict(),
    execute: async ({ analysisId }) => {
      const store = competitiveAnalysisStore(options);
      await store.ensureReady?.();
      const result = await getCompetitiveAnalysis(store, analysisId);
      return {
        analysisId: result.analysisId,
        requestMarkdown: result.requestMarkdown,
        analysisMarkdown: result.analysisMarkdown,
        slidesMarkdown: result.slidesMarkdown ?? '',
        metadata: result.metadata,
      };
    },
  });
}
```

The view tool normalizes `slidesMarkdown?: string` to `slidesMarkdown: string` (empty when absent) so the strict output schema stays satisfied. The route layer treats empty as 404.

- [ ] **Step 6: Update the strict-schema test fixture in `competitive-analysis-tools.test.ts`**

The `'uses strict public input and output schemas'` test constructs an `approvedMetadata` and validates various payloads. Add `slidesMarkdown` to the view-output validation case to keep it strict:

```ts
viewTool.outputSchema!['~standard'].validate({
  analysisId,
  requestMarkdown: saveInput.requestMarkdown,
  analysisMarkdown,
  slidesMarkdown,
  metadata: approvedMetadata,
  unexpected: true,
}),
viewTool.outputSchema!['~standard'].validate({
  analysisId,
  requestMarkdown: saveInput.requestMarkdown,
  analysisMarkdown,
  slidesMarkdown,
  metadata: approvedMetadata,
}),
```

(The second of these should now PASS strict validation; remove it from the rejection set. Only the `unexpected: true` variant should remain as a rejection.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run agent/src/mastra/tools/competitive-analysis-tools.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add agent/src/mastra/tools/competitive-analysis-tools.ts agent/src/mastra/tools/competitive-analysis-tools.test.ts
git commit -m "feat(agent): require slidesMarkdown in competitive save and expose on view"
```

---

## Task 3: Agent skill instructions — slide deck section + View slides link

**Files:**
- Modify: `agent/src/agents/pm-agent-skills.ts`
- Test: `agent/src/agents/__tests__/pm-agent-skills.test.ts`, `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Produces: `competitiveAnalysisInstructions` ends with a `## Slide deck` section and a `View slides:` emission rule.

- [ ] **Step 1: Write failing tests**

In `agent/src/agents/__tests__/pm-agent-skills.test.ts`, add a new test inside `describe('PM Agent skills', ...)`:

```ts
it('defines slide deck rules and view slides link emission', () => {
  expect(competitiveAnalysisInstructions).toContain('## Slide deck');
  expect(competitiveAnalysisInstructions).toContain('marp: true');
  expect(competitiveAnalysisInstructions).toContain('theme: default');
  expect(competitiveAnalysisInstructions).toContain('paginate: true');
  expect(competitiveAnalysisInstructions).toContain('size: 16:9');
  expect(competitiveAnalysisInstructions).toContain('10-14 narrative slides');
  expect(competitiveAnalysisInstructions).toContain('No new claims beyond analysis.md');
  expect(competitiveAnalysisInstructions).toContain('preserve every inline primary-source link');
  expect(competitiveAnalysisInstructions).toContain('Required for the complete-report branch');
  expect(competitiveAnalysisInstructions).toContain('View slides: /reports/competitive/<analysisId>/slides');
});
```

In `agent/src/agents/__tests__/both-agents.test.ts`, inside the existing `'routes weekly, competitive, retrieval, and conversational intents'` test, add:

```ts
expect(instructions).toContain('View slides:');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Append the slide-deck section to `competitiveAnalysisInstructions`**

In `agent/src/agents/pm-agent-skills.ts`, replace the last line of `competitiveAnalysisInstructions` (currently ending with `If saving fails, still return the full completed analysis followed by one short safe line explaining that Garage save failed.`) with the same line plus the appended `## Slide deck` section. The result ends the template string with:

```ts
- If saving fails, still return the full completed analysis followed by one short safe line explaining that Garage save failed.

## Slide deck

Before calling save_competitive_analysis_to_garage in the complete branch, also produce a slide deck as \`slidesMarkdown\` for the same tool call.

The slide deck MUST:

- Begin with this exact front-matter:
  \`\`\`
  ---
  marp: true
  theme: default
  paginate: true
  size: 16:9
  ---
  \`\`\`
- Contain 10-14 narrative slides separated by \`---\` on its own line. Suggested shape: title slide, agenda, executive summary, one slide per top 3-5 competitors, feature matrix slide(s), top 3 gaps, top 3 recommendations, sources slide.
- Use only claims already present in analysis.md. No new claims beyond analysis.md. Preserve every inline primary-source link.
- If the Feature Matrix has more than 5 product columns, split it across two slides or insert a per-slide \`<!-- _size: 4:3 -->\` comment to fit wider tables.

Hard rules:

- Required for the complete-report branch. The incomplete branch produces no slidesMarkdown, no \`Saved analysisId:\`, and no View slides link.
- After a successful complete save, append on a new line: \`View slides: /reports/competitive/<analysisId>/slides\` where \`<analysisId>\` is the ID returned by save_competitive_analysis_to_garage.
- If saving fails, still return the full completed analysis and slide deck followed by one short safe line explaining that Garage save failed.`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/agents/pm-agent-skills.ts agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts
git commit -m "feat(agent): require slide deck in competitive-analysis skill output"
```

---

## Task 4: Client dependency — add @marp-team/marp-core

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Add `@marp-team/marp-core` to client dependencies**

Read `client/package.json` to determine the latest existing dependency style (caret-prefix semver). Add this entry to `dependencies` (alphabetized with the other `@*` packages):

```json
"@marp-team/marp-core": "^4.0.0",
```

- [ ] **Step 2: Install and verify typecheck**

Run: `npm install`
Expected: package installs into `node_modules/@marp-team/marp-core`. Lockfile (`package-lock.json`) updated.

Run: `npm run typecheck --workspace client`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add client/package.json package-lock.json
git commit -m "feat(client): add @marp-team/marp-core dependency"
```

---

## Task 5: Client CompetitiveSlides component — Marp render, print, keyboard nav

**Files:**
- Create: `client/src/components/competitive-slides.tsx`
- Test: `client/src/components/competitive-slides.test.tsx`

**Interfaces:**
- Produces: default export function `CompetitiveSlides({ slidesMarkdown, analysisId }: { slidesMarkdown: string; analysisId: string }) => JSX.Element`. Used by Task 6's route.

- [ ] **Step 1: Write failing jsdom test**

Create `client/src/components/competitive-slides.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

const renderMock = vi.fn((markdown: string) => ({
  html: `<div id="marp-1" class="marpit-slide"><h1>RENDERED</h1><p>${markdown.slice(0, 10)}</p></div>`,
  css: 'section { width: 1280px; }',
}));

vi.mock('@marp-team/marp-core', () => ({
  Marp: class {
    render = renderMock;
  },
}));

import { CompetitiveSlides } from './competitive-slides';

let root: Root | null = null;
function render(ui: ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(ui);
  });
  return container;
}
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
  root = null;
  renderMock.mockClear();
});

describe('CompetitiveSlides', () => {
  it('renders a loading state then renders Marp output', async () => {
    const container = render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown="---\nmarp: true\n---\n# Deck" />,
    );

    expect(renderMock).toHaveBeenCalledWith('---\nmarp: true\n---\n# Deck');
    expect(container.innerHTML).toContain('RENDERED');
    expect(container.querySelector('style')?.textContent).toContain('section { width: 1280px; }');
  });

  it('renders a Print button that triggers window.print', async () => {
    const container = render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown="# Deck" />,
    );
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => { });

    const printButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Print');
    expect(printButton).toBeTruthy();
    printButton!.click();
    expect(printSpy).toHaveBeenCalledOnce();
    printSpy.mockRestore();
  });

  it('renders a fixed safe error when Marp render throws', async () => {
    renderMock.mockImplementationOnce(() => { throw new Error('boom'); });
    const container = render(
      <CompetitiveSlides analysisId="pca_20260723120000_deadbeef" slidesMarkdown="# Deck" />,
    );

    expect(container.textContent).toContain('Could not render slides.');
    expect(container.innerHTML).toContain('/reports/competitive/pca_20260723120000_deadbeef');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/components/competitive-slides.test.tsx`
Expected: FAIL — module `./competitive-slides` does not exist.

- [ ] **Step 3: Implement the component**

Create `client/src/components/competitive-slides.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface CompetitiveSlidesProps {
  analysisId: string;
  slidesMarkdown: string;
}

interface Rendered {
  html: string;
  css: string;
}

export function CompetitiveSlides({ analysisId, slidesMarkdown }: CompetitiveSlidesProps) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { Marp } = await import('@marp-team/marp-core');
        const result = new Marp().render(slidesMarkdown) as Rendered;
        if (cancelled) return;
        setRendered(result);
        setError(false);
      } catch {
        if (cancelled) return;
        setError(true);
        setRendered(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slidesMarkdown]);

  useEffect(() => {
    if (!rendered) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const slides = document.querySelectorAll<HTMLElement>('.competitive-slides-stage [id^="marp-"]');
      if (slides.length === 0) return;
      const current = Array.from(slides).findIndex((slide) => {
        const rect = slide.getBoundingClientRect();
        return rect.top >= -10 && rect.bottom <= window.innerHeight + 10;
      });
      const targetIndex = event.key === 'ArrowRight'
        ? Math.min(current + 1, slides.length - 1)
        : Math.max(current - 1, 0);
      slides[targetIndex]?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rendered]);

  if (error) {
    return (
      <div className="studio-alert studio-alert-error" role="alert">
        <p>Could not render slides.</p>
        <p>
          <Link href={`/reports/competitive/${encodeURIComponent(analysisId)}`}>Back to analysis</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="competitive-slides-shell">
      <div className="competitive-slides-toolbar">
        <button type="button" className="studio-button" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {!rendered ? (
        <p className="competitive-slides-loading">Rendering deck…</p>
      ) : (
        <div className="competitive-slides-stage">
          <style dangerouslySetInnerHTML={{ __html: rendered.css }} />
          <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/components/competitive-slides.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/competitive-slides.tsx client/src/components/competitive-slides.test.tsx
git commit -m "feat(client): add CompetitiveSlides client component"
```

---

## Task 6: Client slides route — server component, identity seam, 404 fallback

**Files:**
- Create: `client/src/app/reports/competitive/[analysisId]/slides/page.tsx`
- Test: `client/src/app/reports/competitive/competitive-pages.test.ts` (extend)

**Interfaces:**
- Consumes: `getCompetitiveAnalysisForUser` from `@/server/competitive-analyses` returns `CompetitiveAnalysisReadResult` with optional `slidesMarkdown`. `CompetitiveSlides` from Task 5.

- [ ] **Step 1: Write failing test — slides route server-renders and 404s appropriately**

Append to `client/src/app/reports/competitive/competitive-pages.test.ts`:

```ts
const slidesMarkdown = '---\nmarp: true\n---\n# Deck';

const analysisWithSlides = {
  ...analysis,
  slidesMarkdown,
};

vi.mock('@/components/competitive-slides', () => ({
  CompetitiveSlides: ({ slidesMarkdown, analysisId }: { slidesMarkdown: string; analysisId: string }) =>
    `SLIDES:${analysisId}:${slidesMarkdown.slice(0, 6)}`,
}));

import CompetitiveSlidesPage from './[analysisId]/slides/page';

describe('competitive analysis slides route', () => {
  it('404s when analysis is missing slidesMarkdown', async () => {
    mocks.getAnalysis.mockResolvedValue({ ...analysis });

    await expect(CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it('404s when analysis service returns invalid-analysis-id or not-found', async () => {
    mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(
      'not-found', 404, 'Competitive analysis not found.',
    ));

    await expect(CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the slides component when slidesMarkdown present', async () => {
    mocks.getAnalysis.mockResolvedValue(analysisWithSlides);

    const markup = renderToStaticMarkup(await CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('SLIDES:pca_20260723120000_deadbeef:---\nma');
    expect(markup).toContain('Back to analysis');
    expect(markup).toContain('href="/reports/competitive"');
  });

  it.each([
    ['forbidden', 403, 'Authentication is required.'],
    ['storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
  ] as const)('renders safe error for %s service failure', async (code, status, message) => {
    mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(code, status, message));

    const markup = renderToStaticMarkup(await CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('Slides unavailable');
    expect(markup).toContain(message);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: FAIL — `CompetitiveSlidesPage` import path does not resolve.

- [ ] **Step 3: Create the route**

Create `client/src/app/reports/competitive/[analysisId]/slides/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CompetitiveSlides } from '@/components/competitive-slides';
import { StudioNav } from '@/components/studio/studio-nav';
import {
  CompetitiveAnalysisServiceError,
  getCompetitiveAnalysisForUser,
} from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysisSlidesPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
  const { analysisId } = await params;
  let slidesMarkdown: string | undefined;
  let errorMessage: string | undefined;

  try {
    const analysis = await getCompetitiveAnalysisForUser(analysisId);
    slidesMarkdown = analysis.slidesMarkdown;
  } catch (error) {
    if (
      error instanceof CompetitiveAnalysisServiceError
      && (error.code === 'invalid-analysis-id' || error.code === 'not-found')
    ) {
      notFound();
    }
    errorMessage = error instanceof CompetitiveAnalysisServiceError
      ? error.message
      : 'Could not load competitive analysis.';
  }

  if (!errorMessage && (!slidesMarkdown || slidesMarkdown.trim().length === 0)) {
    notFound();
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Competitive analysis slides</p>
            <h1>{analysisId}</h1>
            <p>Rendered Marp deck built from the saved analysis.</p>
          </div>
          <Link className="studio-button" href={`/reports/competitive/${encodeURIComponent(analysisId)}`}>
            Back to analysis
          </Link>
        </header>

        <section className="studio-section">
          {errorMessage ? (
            <div className="studio-alert studio-alert-error" role="alert">
              <p>Slides unavailable</p>
              <p>{errorMessage}</p>
            </div>
          ) : slidesMarkdown ? (
            <CompetitiveSlides analysisId={analysisId} slidesMarkdown={slidesMarkdown} />
          ) : null}
        </section>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: PASS (all existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add client/src/app/reports/competitive/[analysisId]/slides/page.tsx client/src/app/reports/competitive/competitive-pages.test.ts
git commit -m "feat(client): add /reports/competitive/<id>/slides route"
```

---

## Task 7: CSS — scoped stage + print rules

**Files:**
- Modify: `client/src/app/studio.css`

- [ ] **Step 1: Append the new slide rules to `studio.css`**

Append at the end of `client/src/app/studio.css`:

```css
.competitive-slides-shell {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.competitive-slides-toolbar {
  display: flex;
  justify-content: flex-end;
}

.competitive-slides-loading {
  padding: 4rem 1rem;
  text-align: center;
  color: var(--studio-muted, #666);
}

.competitive-slides-stage {
  overflow: hidden;
}

.competitive-slides-stage .marpit-slide {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  margin: 0 auto 1.5rem;
}

@media print {
  .studio-nav,
  .studio-page-header,
  .competitive-slides-toolbar,
  .competitive-slides-loading {
    display: none !important;
  }

  .competitive-slides-stage .marpit-slide {
    box-shadow: none;
    margin: 0;
    page-break-after: always;
    break-after: page;
  }

  .competitive-slides-stage .marpit-slide:last-child {
    page-break-after: auto;
    break-after: auto;
  }
}

@page {
  size: 1280px 720px;
  margin: 0;
}
```

- [ ] **Step 2: Verify lint and CSS parse**

Run: `npm run lint --workspace client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/app/studio.css
git commit -m "feat(client): scope competitive-slides stage and add print CSS"
```

---

## Task 8: Link surfacing — detail page button + card grid badge

**Files:**
- Modify: `client/src/app/reports/competitive/[analysisId]/page.tsx`
- Modify: `client/src/app/reports/competitive/page.tsx`
- Test: `client/src/app/reports/competitive/competitive-pages.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

In `client/src/app/reports/competitive/competitive-pages.test.ts`, extend the `analysis` fixture (used by detail page tests) to include slidesMarkdown (so the detail page can show the View slides link only when slides exist). For legacy-missing cases, add a `analysisLegacy` fixture without slidesMarkdown.

Add to the detail-page describe block:

```ts
const analysisWithSlides = { ...analysis, slidesMarkdown: '---\nmarp: true\n---\n# Deck' };

it('renders a View slides button when slidesMarkdown is present', async () => {
  mocks.getAnalysis.mockResolvedValue(analysisWithSlides);

  const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
    params: Promise.resolve({ analysisId }),
  }));

  expect(markup).toContain('View slides');
  expect(markup).toContain(`/reports/competitive/${analysisId}/slides`);
});

it('hides the View slides button when slidesMarkdown is missing (legacy)', async () => {
  mocks.getAnalysis.mockResolvedValue({ ...analysis });

  const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
    params: Promise.resolve({ analysisId }),
  }));

  expect(markup).not.toContain('View slides');
});
```

Add to the list-page describe block:

```ts
it('renders a Slides badge on each card', async () => {
  mocks.listAnalyses.mockResolvedValue([metadata]);

  const markup = renderToStaticMarkup(await CompetitiveAnalysesPage());

  expect(markup).toContain('Slides');
  expect(markup).toContain(`/reports/competitive/${analysisId}/slides`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Add View slides button to the detail page**

In `client/src/app/reports/competitive/[analysisId]/page.tsx`, replace the `studio-report-header` block:

```tsx
<header className="studio-page-header studio-report-header">
  <div>
    <p className="studio-eyebrow">Competitive analysis</p>
    <h1>{analysis.analysisId}</h1>
    <p>Saved analysis first, followed by storage metadata and original request.</p>
  </div>
  <div className="studio-report-header-actions">
    {analysis.slidesMarkdown && analysis.slidesMarkdown.trim().length > 0 ? (
      <Link
        className="studio-button"
        href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
      >
        View slides
      </Link>
    ) : null}
    <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
  </div>
</header>
```

- [ ] **Step 4: Add Slides badge to each card in the list page**

In `client/src/app/reports/competitive/page.tsx`, replace the `<div className="studio-card-actions">` block inside the card:

```tsx
<div className="studio-card-actions">
  <Link
    className="studio-button studio-button-primary"
    href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}`}
  >
    View analysis
  </Link>
  <Link
    className="studio-button"
    href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
  >
    Slides
  </Link>
</div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/reports/competitive/[analysisId]/page.tsx client/src/app/reports/competitive/page.tsx client/src/app/reports/competitive/competitive-pages.test.ts
git commit -m "feat(client): surface slides links on detail and list pages"
```

---

## Task 9: UI-structure test — slides route allowed and storage-isolated

**Files:**
- Modify: `client/src/lib/ui-structure.test.ts`

- [ ] **Step 1: Add the slides route to optional sources and assert isolation**

In `client/src/lib/ui-structure.test.ts`, alongside the existing optional reads:

```ts
const competitiveAnalysisSlidesPage = readOptionalSource('../app/reports/competitive/[analysisId]/slides/page.tsx');
```

Add a new test inside `describe('requested UI structure', ...)`:

```ts
it('renders the competitive slides route through the shared client component and never touches Garage directly', () => {
  expect(competitiveAnalysisSlidesPage).toContain("export const dynamic = 'force-dynamic'");
  expect(competitiveAnalysisSlidesPage).not.toContain("'use client'");
  expect(competitiveAnalysisSlidesPage).toContain("from '@/components/competitive-slides'");
  expect(competitiveAnalysisSlidesPage).toContain("from '@/server/competitive-analyses'");
  expect(competitiveAnalysisSlidesPage).not.toContain('from \'@chekku/storage\'');
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/ui-structure.test.ts
git commit -m "test(client): lock slides route contract in ui-structure"
```

---

## Task 10: Docs — AGENTS.md, ARCHITECTURE.md, OPERATIONS.md

**Files:**
- Modify: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`

- [ ] **Step 1: Update AGENTS.md persisted-key set + route list + invariant**

In `AGENTS.md`, locate the section "PM analyses and reports". Find the line:

```text
- Competitive IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Persist only `competitive-analyses/<analysisId>/{request.md,analysis.md,metadata.json}` relative keys; metadata writes last.
```

Replace with:

```text
- Competitive IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Persist only `competitive-analyses/<analysisId>/{request.md,analysis.md,slides.md,metadata.json}` relative keys; metadata writes last. Every complete competitive save produces a non-blank `slides.md` Marp deck; legacy analyses saved before this feature have no `slides.md` and the slides route returns 404.
```

In the same section, locate:

```text
- Preserve routes `/reports`, `/reports/weekly`, `/reports/<pmr-id>`, `/reports/competitive`, and `/reports/competitive/<pca-id>`; existing weekly links must not move.
```

Replace with:

```text
- Preserve routes `/reports`, `/reports/weekly`, `/reports/<pmr-id>`, `/reports/competitive`, `/reports/competitive/<pca-id>`, and `/reports/competitive/<pca-id>/slides`; existing weekly and competitive links must not move.
```

Add a new bullet to the same section:

```text
- The slides route renders the saved `slides.md` through `@marp-team/marp-core` in a client component. The route is server-rendered through `client/src/server/competitive-analyses.ts` and the same identity seam as the rest of `/reports/*`; no public access, no Chromium on the server, no PPTX export in v1. Print-to-PDF uses `window.print()` and print CSS only.
```

- [ ] **Step 2: Update docs/ARCHITECTURE.md**

Locate the section describing PM analyses and routes. Add a sentence noting that competitive analyses ship with a slide deck and the slides route exists. Example paragraph appended to the PM section:

```markdown
The competitive analysis record includes a `slides.md` Marp deck produced by the same agent run. The deck renders in-app at `/reports/competitive/<analysisId>/slides` through a client component that lazy-imports `@marp-team/marp-core`; the route is server-rendered behind the local identity seam, with browser print providing PDF export. No Chromium runs on the server in v1.
```

- [ ] **Step 3: Update docs/OPERATIONS.md**

Locate the competitive analysis operational notes. Add a new subsection "## Competitive analysis slides" with operational guidance:

```markdown
## Competitive analysis slides

Every completed `/competitive-analysis` run produces a `slides.md` Marp deck saved alongside the analysis. Open it at `/reports/competitive/<pca-id>/slides`. The deck renders client-side through `@marp-team/marp-core`; the route is server-rendered behind the same identity seam as the rest of `/reports/*`. Use the Print button to save as PDF via the browser; no server-side rendering, no PPTX, no public sharing in v1. Legacy analyses saved before this feature have no `slides.md` and the route returns 404 — re-run `/competitive-analysis` to produce one.
```

- [ ] **Step 4: Verify typecheck + lint still pass**

Run: `npm run check`
Expected: PASS (docs-only change, but spot-check that no test reads exact AGENTS.md text that just changed).

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git commit -m "docs: document competitive analysis slides route and persisted slides.md"
```

---

## Final Verification

After all 10 tasks land:

- [ ] **Run full check**

```bash
npm run check
```

Expected: typecheck + lint + vitest (target test count is previous total + ~10 new tests across storage/agent/client). Zero failures.

- [ ] **Run full build**

```bash
npm run build --workspace client
npm run build --workspace agent
```

Expected: both succeed.

- [ ] **Whitespace check**

```bash
git diff --check
```

Expected: clean.

- [ ] **Manual smoke (optional, requires live SearXNG + Web Reader)**

1. Start dev stack: `npm run dev`.
2. In chat with PM Agent active, run `/competitive-analysis gpt vs claude vs gemini`.
3. Wait for completion. Confirm final response contains `View slides: /reports/competitive/<id>/slides`.
4. Click the link. Confirm deck renders, ArrowRight/ArrowLeft navigate slides, Print button opens the browser print dialog with one slide per page.
5. Visit `/reports/competitive/<id>`. Confirm View slides button present.
6. Visit `/reports/competitive`. Confirm Slides badge on the new card.
7. Visit `/reports/competitive/<id>/slides` for a pre-feature legacy analysis (if any). Confirm 404.

---

## Self-Review

**Spec coverage:**

- ✅ Auto-generate `slides.md` as part of complete save — Task 1 (storage) + Task 2 (tool) + Task 3 (skill instruction).
- ✅ New route `/reports/competitive/<id>/slides` — Task 6.
- ✅ Browser print-to-PDF + print CSS — Task 5 (component) + Task 7 (CSS).
- ✅ Link surfacing in chat (skill emission — Task 3), detail page (Task 8), card grid (Task 8).
- ✅ 4-key persisted set — Task 1.
- ✅ 404 when slides absent (legacy) — Task 6.
- ✅ Marp front-matter `marp: true theme: default paginate: true size: 16:9` — Task 3 (skill instruction).
- ✅ 10-14 narrative slides rule — Task 3.
- ✅ No new claims beyond analysis.md — Task 3.
- ✅ AGENTS.md / docs updates — Task 10.

**Placeholder scan:** None. Every step has complete code or complete shell command.

**Type consistency:**

- `slidesMarkdown: string` in `SaveCompetitiveAnalysisInput` (Task 1) — required, validated.
- `slidesMarkdown?: string` in `CompetitiveAnalysisReadResult` (Task 1) — optional for legacy compatibility.
- `slidesMarkdown: z.string()` in view tool output (Task 2) — coerced to empty string when storage returns undefined.
- `slidesMarkdown: string` in `CompetitiveSlides` props (Task 5) — route guarantees non-empty before rendering.
- `slidesObjectKey` consistent in `competitiveAnalysisKeysFor` return (Task 1) and storage test expectations (Task 1).

**Scope check:** Single PR-sized. Ten tasks, each independently testable and revertable.
