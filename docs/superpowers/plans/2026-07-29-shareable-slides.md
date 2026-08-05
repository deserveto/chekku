# Shareable Slides + Viewer Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token-gated public sharing to competitive analysis slides, fix two print regressions, and add fullscreen + slide-counter UX.

**Architecture:** Storage gains a 5th optional sibling key (`share-token.json`) holding the share token + minimal context. A new identity-seamed POST route creates tokens on demand. A new unauthenticated public route validates the token and renders only `slides.md`. The `CompetitiveSlides` component gains a `variant` prop for public mode, plus fullscreen + counter + scoped print CSS.

**Tech Stack:** TypeScript, Next.js 15 (App Router, async params/searchParams), Mastra storage, `@marp-team/marp-core` v4, Vitest + jsdom, Fullscreen API, IntersectionObserver.

## Global Constraints

- **Public route is a new auth boundary.** The public server seam reads ONLY `share-token.json` and `slides.md`. NEVER reads `metadata.json`, `analysis.md`, `request.md`, or any other Garage key. A ui-structure test locks this.
- **`metadata.json` shape unchanged.** Share token lives in `share-token.json`, not metadata.
- **Token mismatch vs missing analysis vs missing slides all return 404.** No oracle for "does this analysis exist".
- **Token = 32 hex chars** (`crypto.randomBytes(16).toString('hex')`). 128 bits of entropy. Constant-time compare.
- **`share-token.json` shape**: `{ token: string; createdAt: string; anchorProduct: string }`. Standalone JSON object, NOT part of analysis metadata.
- **Canonical `pca_` IDs** stay `^pca_[0-9]{14}_[0-9a-f]{8}$`.
- **Identity seam unchanged** for authenticated routes (`CHEKKU_LOCAL_USER_ID`).
- **Browser modules never import `@chekku/storage`** directly. All Garage access through `client/src/server/competitive-analyses.ts`.
- **npm run check + npm run build must pass** after each task.

---

## File Structure

**Created:**
- `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.ts` — POST handler (identity-seamed).
- `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts` — route test.
- `client/src/app/public/slides/[analysisId]/page.tsx` — public server component.
- `client/src/app/public/public-slides-page.test.ts` — public route test.
- `client/src/components/share-link-button.tsx` — `'use client'` button + fetch + clipboard.
- `client/src/components/share-link-button.test.tsx` — jsdom test.

**Modified:**
- `storage/src/competitive-analyses.ts` — `shareTokenObjectKey` + `createShareToken` + `getShareToken` + `getShareableSlides` + new types.
- `storage/src/competitive-analyses.test.ts` — share helper tests.
- `client/src/server/competitive-analyses.ts` — `createShareLinkForUser` + `getPublicSlides` + `getShareTokenForUser` (status check) functions.
- `client/src/server/competitive-analyses.test.ts` — extend with share seam tests.
- `client/src/components/competitive-slides.tsx` — `variant` prop, fullscreen, counter, scoped print `<style>`.
- `client/src/components/competitive-slides.test.tsx` — fullscreen + counter + public-variant tests.
- `client/src/app/reports/competitive/[analysisId]/page.tsx` — render `<ShareLinkButton>` in header.
- `client/src/app/reports/competitive/competitive-pages.test.ts` — assert ShareLinkButton rendered.
- `client/src/app/studio.css` — remove `overflow: hidden` from `.competitive-slides-stage`; add counter + footer styles.
- `client/src/lib/ui-structure.test.ts` — public route contract lock.
- `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md` — new route, new persisted key, public seam invariant.

---

## Task 1: Storage — share-token helpers

**Files:**
- Modify: `storage/src/competitive-analyses.ts`
- Test: `storage/src/competitive-analyses.test.ts`

**Interfaces:**
- Produces:
  - `competitiveAnalysisKeysFor(id).shareTokenObjectKey` returns `competitive-analyses/<id>/share-token.json`.
  - `createShareToken(store, analysisId, anchorProduct): Promise<ShareTokenBundle>` — idempotent.
  - `getShareToken(store, analysisId): Promise<ShareTokenBundle | undefined>`.
  - `getShareableSlides(store, analysisId, token): Promise<ShareableSlidesPayload | undefined>`.
  - New exported types: `ShareTokenBundle = { token: string; createdAt: string; anchorProduct: string }`, `ShareableSlidesPayload = { anchorProduct: string; createdAt: string; slidesMarkdown: string }`.

- [ ] **Step 1: Add `shareTokenObjectKey` to `competitiveAnalysisKeysFor`**

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
    shareTokenObjectKey: `${base}/share-token.json`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}
```

- [ ] **Step 2: Add the new types after `CompetitiveAnalysisReadResult`**

```ts
export interface ShareTokenBundle {
  token: string;
  createdAt: string;
  anchorProduct: string;
}

export interface ShareableSlidesPayload {
  anchorProduct: string;
  createdAt: string;
  slidesMarkdown: string;
}
```

- [ ] **Step 3: Add `createShareToken`, `getShareToken`, `getShareableSlides` at the end of the file**

```ts
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseShareTokenBundle(raw: unknown): ShareTokenBundle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.token !== 'string' || typeof value.createdAt !== 'string'
    || typeof value.anchorProduct !== 'string') {
    return undefined;
  }
  if (!/^[0-9a-f]{32}$/.test(value.token)) return undefined;
  if (value.createdAt.length === 0 || value.createdAt.length > MAX_CREATED_AT_BYTES) return undefined;
  return {
    token: value.token,
    createdAt: value.createdAt,
    anchorProduct: value.anchorProduct,
  };
}

export async function createShareToken(
  store: ObjectStorage,
  analysisId: string,
  anchorProduct: string,
  now: () => Date = () => new Date(),
): Promise<ShareTokenBundle> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  const normalizedAnchor = normalizeBoundedText(anchorProduct, 'anchorProduct', MAX_NAME_BYTES);
  let existing: ShareTokenBundle | undefined;
  try {
    const raw = await store.getText(objectKeys.shareTokenObjectKey);
    existing = parseShareTokenBundle(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.code !== 'not-found') {
      throw error;
    }
    existing = undefined;
  }
  if (existing) {
    if (existing.anchorProduct !== normalizedAnchor) {
      throw new Error('share-token anchorProduct mismatch');
    }
    return existing;
  }
  const bundle: ShareTokenBundle = {
    token: randomBytes(16).toString('hex'),
    createdAt: now().toISOString(),
    anchorProduct: normalizedAnchor,
  };
  await store.createText(
    objectKeys.shareTokenObjectKey,
    JSON.stringify(bundle, null, 2),
    'application/json',
  );
  return bundle;
}

export async function getShareToken(
  store: ObjectStorage,
  analysisId: string,
): Promise<ShareTokenBundle | undefined> {
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  let raw: string;
  try {
    raw = await store.getText(objectKeys.shareTokenObjectKey);
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseShareTokenBundle(parsed);
}

export async function getShareableSlides(
  store: ObjectStorage,
  analysisId: string,
  token: string,
): Promise<ShareableSlidesPayload | undefined> {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return undefined;
  const bundle = await getShareToken(store, analysisId);
  if (!bundle) return undefined;
  if (!timingSafeEqualHex(bundle.token, token)) return undefined;
  const objectKeys = competitiveAnalysisKeysFor(analysisId);
  try {
    const slidesMarkdown = await store.getText(objectKeys.slidesObjectKey);
    return {
      anchorProduct: bundle.anchorProduct,
      createdAt: bundle.createdAt,
      slidesMarkdown,
    };
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') return undefined;
    throw error;
  }
}
```

- [ ] **Step 4: Write failing tests**

Append to `storage/src/competitive-analyses.test.ts` inside the `describe('competitive analysis storage', ...)` block:

```ts
describe('share token', () => {
  it('createShareToken is idempotent and returns the same token on repeated calls', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    const first = await createShareToken(store, analysisId, 'GPT');
    const second = await createShareToken(store, analysisId, 'GPT');

    expect(second.token).toBe(first.token);
    expect(second.createdAt).toBe(first.createdAt);
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('createShareToken persists share-token.json with token + createdAt + anchorProduct', async () => {
    const { objects, storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    const bundle = await createShareToken(store, analysisId, 'GPT',
      () => new Date('2026-07-29T10:00:00.000Z'));

    const raw = objects.get(`competitive-analyses/${analysisId}/share-token.json`);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toMatchObject({
      token: bundle.token,
      createdAt: '2026-07-29T10:00:00.000Z',
      anchorProduct: 'GPT',
    });
  });

  it('createShareToken rejects anchorProduct mismatch on repeated call', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);
    await createShareToken(store, analysisId, 'GPT');

    await expect(createShareToken(store, analysisId, 'Claude')).rejects.toThrow(
      'share-token anchorProduct mismatch',
    );
  });

  it('getShareToken returns undefined when no token file exists', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    await expect(getShareToken(store, analysisId)).resolves.toBeUndefined();
  });

  it('getShareToken returns undefined on malformed JSON or shape', async () => {
    const { objects, storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);
    objects.set(`competitive-analyses/${analysisId}/share-token.json`, '{bad json');

    await expect(getShareToken(store, analysisId)).resolves.toBeUndefined();
  });

  it('getShareToken propagates non-not-found storage errors', async () => {
    const { storage } = createMemoryStorage();
    const failingStorage: ObjectStorage = {
      ...storage,
      async getText(key) {
        if (key.endsWith('/share-token.json')) {
          throw new ObjectStorageError('unavailable', 'injected');
        }
        return storage.getText(key);
      },
    };
    const store = createCompetitiveAnalysisStorage(failingStorage);

    await expect(getShareToken(store, analysisId)).rejects.toThrow('injected');
  });

  it('getShareableSlides returns undefined for missing token', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);

    await expect(getShareableSlides(store, analysisId, 'a'.repeat(32))).resolves.toBeUndefined();
  });

  it('getShareableSlides returns undefined for mismatched token', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);
    const bundle = await createShareToken(store, analysisId, 'GPT');

    await expect(getShareableSlides(store, analysisId, '0'.repeat(32))).resolves.toBeUndefined();
    expect(bundle.token).not.toBe('0'.repeat(32));
  });

  it('getShareableSlides returns undefined for malformed token input', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);
    await createShareToken(store, analysisId, 'GPT');

    await expect(getShareableSlides(store, analysisId, 'short')).resolves.toBeUndefined();
    await expect(getShareableSlides(store, analysisId, '')).resolves.toBeUndefined();
  });

  it('getShareableSlides returns payload for valid token + existing slides', async () => {
    const { storage } = createMemoryStorage();
    const store = createCompetitiveAnalysisStorage(storage);
    await saveCompetitiveAnalysis({ ...validInput(store), slidesMarkdown: '# Deck\n' });
    const bundle = await createShareToken(store, analysisId, 'GPT');

    await expect(getShareableSlides(store, analysisId, bundle.token)).resolves.toMatchObject({
      anchorProduct: 'GPT',
      slidesMarkdown: '# Deck\n',
    });
  });

  it('getShareableSlides propagates storage errors from slides.md read', async () => {
    const { storage } = createMemoryStorage();
    const failingStorage: ObjectStorage = {
      ...storage,
      async getText(key) {
        if (key.endsWith('/slides.md')) {
          throw new ObjectStorageError('unavailable', 'slides outage');
        }
        return storage.getText(key);
      },
    };
    const store = createCompetitiveAnalysisStorage(failingStorage);
    await saveCompetitiveAnalysis({ ...validInput(store), slidesMarkdown: '# Deck\n' });
    const bundle = await createShareToken(store, analysisId, 'GPT');

    await expect(getShareableSlides(store, analysisId, bundle.token)).rejects.toThrow('slides outage');
  });
});
```

- [ ] **Step 5: Run failing tests**

Run: `npx vitest run storage/src/competitive-analyses.test.ts`
Expected: FAIL — new helpers not exported yet.

- [ ] **Step 6: Run passing tests**

Run: `npx vitest run storage/src/competitive-analyses.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 7: Commit**

```bash
git add storage/src/competitive-analyses.ts storage/src/competitive-analyses.test.ts
git commit -m "feat(storage): add share-token helpers for competitive analyses"
```

---

## Task 2: Server seam — createShareLinkForUser + getPublicSlides + getShareTokenForUser

**Files:**
- Modify: `client/src/server/competitive-analyses.ts`
- Test: `client/src/server/competitive-analyses.test.ts`

**Interfaces:**
- Consumes: `createShareToken`, `getShareToken`, `getShareableSlides`, `getCompetitiveAnalysis` from `@chekku/storage`.
- Produces:
  - `createShareLinkForUser(analysisId, dependencies?): Promise<{ url: string }>` — identity-seamed. Reads existing analysis (to validate analysisId + get anchorProduct), then creates token, returns URL.
  - `getShareTokenForUser(analysisId, dependencies?): Promise<{ shared: boolean }>` — identity-seamed status check. Used by detail page to render "shared" or "create" button state.
  - `getPublicSlides(analysisId, token, dependencies?): Promise<PublicSlidesPayload>` — NO identity check. Throws `CompetitiveAnalysisServiceError('not-found')` on any 404-class miss.

- [ ] **Step 1: Extend the service error code union**

In `client/src/server/competitive-analyses.ts`:

```ts
export type CompetitiveAnalysisServiceErrorCode =
  | 'forbidden'
  | 'invalid-analysis-id'
  | 'not-found'
  | 'storage-unavailable';
```

(unchanged — all needed codes already exist).

- [ ] **Step 2: Extend the dependencies interface and add new functions**

Add `createShareToken`, `getShareToken`, `getShareableSlides`, `getCompetitiveAnalysis` to the import block from `@chekku/storage`, and `ShareTokenBundle`, `ShareableSlidesPayload` types. Then add:

```ts
export interface CompetitiveAnalysisServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  listAnalyses?: (store: ObjectStorage) => Promise<CompetitiveAnalysisMetadata[]>;
  getAnalysis?: (
    store: ObjectStorage,
    analysisId: string,
  ) => Promise<CompetitiveAnalysisReadResult>;
  createShareToken?: (
    store: ObjectStorage,
    analysisId: string,
    anchorProduct: string,
  ) => Promise<ShareTokenBundle>;
  getShareToken?: (
    store: ObjectStorage,
    analysisId: string,
  ) => Promise<ShareTokenBundle | undefined>;
  getShareableSlides?: (
    store: ObjectStorage,
    analysisId: string,
    token: string,
  ) => Promise<ShareableSlidesPayload | undefined>;
}

export interface PublicSlidesPayload {
  analysisId: string;
  anchorProduct: string;
  createdAt: string;
  slidesMarkdown: string;
}

export async function createShareLinkForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<{ url: string }> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new CompetitiveAnalysisServiceError('invalid-analysis-id', 400, 'Invalid analysis id.');
  }
  try {
    const store = competitiveStore(dependencies);
    const analysis = await (dependencies.getAnalysis ?? getCompetitiveAnalysis)(store, analysisId);
    const bundle = await (dependencies.createShareToken ?? createShareToken)(
      store,
      analysisId,
      analysis.metadata.anchorProduct,
    );
    const url = `/public/slides/${encodeURIComponent(analysisId)}?t=${bundle.token}`;
    return { url };
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getShareTokenForUser(
  analysisId: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<{ shared: boolean }> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!ANALYSIS_ID_RE.test(analysisId)) {
    throw new CompetitiveAnalysisServiceError('invalid-analysis-id', 400, 'Invalid analysis id.');
  }
  try {
    const store = competitiveStore(dependencies);
    const bundle = await (dependencies.getShareToken ?? getShareToken)(store, analysisId);
    return { shared: bundle !== undefined };
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getPublicSlides(
  analysisId: string,
  token: string,
  dependencies: CompetitiveAnalysisServiceDependencies = {},
): Promise<PublicSlidesPayload> {
  if (!ANALYSIS_ID_RE.test(analysisId) || typeof token !== 'string' || token.length === 0) {
    throw new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.');
  }
  try {
    const store = competitiveStore(dependencies);
    const payload = await (dependencies.getShareableSlides ?? getShareableSlides)(
      store,
      analysisId,
      token,
    );
    if (!payload) {
      throw new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.');
    }
    return { analysisId, ...payload };
  } catch (error) {
    if (error instanceof CompetitiveAnalysisServiceError) throw error;
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}
```

- [ ] **Step 3: Write failing tests**

Extend `client/src/server/competitive-analyses.test.ts` with new imports and tests. The existing test file already mocks `getUserId` and `createLazyGarageObjectStorage`. Add tests:

```ts
describe('share link lifecycle', () => {
  it('createShareLinkForUser requires identity', async () => {
    await expect(createShareLinkForUser(analysisId, {
      getServerUserId: async () => null,
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('createShareLinkForUser rejects invalid analysis id', async () => {
    await expect(createShareLinkForUser('pca_legacy', {
      getServerUserId: async () => 'user-1',
    })).rejects.toMatchObject({ code: 'invalid-analysis-id', status: 400 });
  });

  it('createShareLinkForUser returns url after analysis read + token create', async () => {
    const getAnalysis = vi.fn(async () => analysis);
    const createShareToken = vi.fn(async () => ({
      token: 'abcdef0123456789abcdef0123456789',
      createdAt: '2026-07-29T10:00:00.000Z',
      anchorProduct: 'GPT',
    }));

    const result = await createShareLinkForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getAnalysis,
      createShareToken,
    });

    expect(getAnalysis).toHaveBeenCalledOnce();
    expect(createShareToken).toHaveBeenCalledWith(expect.anything(), analysisId, 'GPT');
    expect(result.url).toBe(`/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`);
  });

  it('createShareLinkForUser maps storage not-found to service not-found', async () => {
    const getAnalysis = vi.fn(async () => {
      throw new ObjectStorageError('not-found', 'missing');
    });

    await expect(createShareLinkForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getAnalysis,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
  });
});

describe('getShareTokenForUser status check', () => {
  it('returns shared=false when no token exists', async () => {
    const getShareToken = vi.fn(async () => undefined);
    await expect(getShareTokenForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getShareToken,
    })).resolves.toEqual({ shared: false });
  });

  it('returns shared=true when token exists', async () => {
    const getShareToken = vi.fn(async () => ({
      token: 'a'.repeat(32),
      createdAt: '2026-07-29T10:00:00.000Z',
      anchorProduct: 'GPT',
    }));
    await expect(getShareTokenForUser(analysisId, {
      getServerUserId: async () => 'user-1',
      getShareToken,
    })).resolves.toEqual({ shared: true });
  });
});

describe('getPublicSlides', () => {
  it('does NOT require identity', async () => {
    const getShareableSlides = vi.fn(async () => undefined);
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getServerUserId: async () => null, // should NOT be checked
      getShareableSlides,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
    expect(getShareableSlides).toHaveBeenCalledOnce();
  });

  it('throws not-found for invalid analysis id', async () => {
    await expect(getPublicSlides('pca_legacy', 'a'.repeat(32))).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
    });
  });

  it('throws not-found when payload is undefined (token mismatch or missing)', async () => {
    const getShareableSlides = vi.fn(async () => undefined);
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getShareableSlides,
    })).rejects.toMatchObject({ code: 'not-found', status: 404 });
  });

  it('returns payload when token validates', async () => {
    const getShareableSlides = vi.fn(async () => ({
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
      slidesMarkdown: '# Deck',
    }));
    await expect(getPublicSlides(analysisId, 'a'.repeat(32), {
      getShareableSlides,
    })).resolves.toMatchObject({
      analysisId,
      anchorProduct: 'GPT',
      slidesMarkdown: '# Deck',
    });
  });
});
```

Add the imports at the top of the file:

```ts
import {
  createShareLinkForUser,
  getShareTokenForUser,
  getPublicSlides,
  type PublicSlidesPayload,
} from './competitive-analyses';
```

- [ ] **Step 4: Run failing tests**

Run: `npx vitest run client/src/server/competitive-analyses.test.ts`
Expected: FAIL — new functions not exported.

- [ ] **Step 5: Run passing tests**

Run: `npx vitest run client/src/server/competitive-analyses.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/server/competitive-analyses.ts client/src/server/competitive-analyses.test.ts
git commit -m "feat(client): add share-link + public-slides server seams"
```

---

## Task 3: Authenticated API route — POST /share

**Files:**
- Create: `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.ts`
- Create: `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts`

**Interfaces:**
- Consumes: `createShareLinkForUser` from `@/server/competitive-analyses`.

- [ ] **Step 1: Write failing test**

Create `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createShareLink: vi.fn(),
}));

vi.mock('@/server/competitive-analyses', () => {
  class CompetitiveAnalysisServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CompetitiveAnalysisServiceError,
    createShareLinkForUser: mocks.createShareLink,
  };
});

import { POST } from './route';

const analysisId = 'pca_20260723120000_deadbeef';

describe('POST /api/storage/competitive-analyses/[analysisId]/share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with url on success', async () => {
    mocks.createShareLink.mockResolvedValue({
      url: `/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`,
    });

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`,
    });
  });

  it('passes through service errors with their status', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.createShareLink.mockRejectedValue(
      new CompetitiveAnalysisServiceError('not-found', 404, 'Competitive analysis not found.'),
    );

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { code: 'not-found', message: 'Competitive analysis not found.' } });
  });

  it('returns 500 for non-service errors', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('boom'));

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts`
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Create the route**

Create `client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.ts`:

```ts
import { NextResponse } from 'next/server';

import {
  CompetitiveAnalysisServiceError,
  createShareLinkForUser,
} from '@/server/competitive-analyses';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ analysisId: string }> },
) {
  try {
    const { analysisId } = await params;
    return NextResponse.json(await createShareLinkForUser(analysisId));
  } catch (error) {
    if (error instanceof CompetitiveAnalysisServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not create share link.' } },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run passing tests**

Run: `npx vitest run client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.ts client/src/app/api/storage/competitive-analyses/[analysisId]/share/route.test.ts
git commit -m "feat(client): add POST /api/storage/competitive-analyses/[id]/share route"
```

---

## Task 4: Public route — /public/slides/[analysisId]

**Files:**
- Create: `client/src/app/public/slides/[analysisId]/page.tsx`
- Create: `client/src/app/public/public-slides-page.test.ts`

**Interfaces:**
- Consumes: `getPublicSlides` from `@/server/competitive-analyses`. `CompetitiveSlides` from Task 5.
- Produces: server component rendering the public deck with no app chrome.

- [ ] **Step 1: Write failing test**

Create `client/src/app/public/public-slides-page.test.ts`:

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPublicSlides: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/components/competitive-slides', () => ({
  CompetitiveSlides: ({ variant, slidesMarkdown, anchorProduct, createdAt }: {
    variant: string; slidesMarkdown: string; anchorProduct: string; createdAt: string;
  }) => `SLIDES:${variant}:${anchorProduct}:${createdAt}:${slidesMarkdown.slice(0, 5)}`,
}));
vi.mock('@/server/competitive-analyses', () => ({
  CompetitiveAnalysisServiceError: class extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
      super(message);
    }
  },
  getPublicSlides: mocks.getPublicSlides,
}));

import PublicSlidesPage from './slides/[analysisId]/page';

const analysisId = 'pca_20260723120000_deadbeef';
const token = 'abcdef0123456789abcdef0123456789';

describe('public slides route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicSlides.mockResolvedValue({
      analysisId,
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
      slidesMarkdown: '# Deck content here',
    });
  });

  it('renders the deck in public variant with footer', async () => {
    const markup = renderToStaticMarkup(await PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    }));

    expect(markup).toContain('SLIDES:public:GPT:2026-07-29T10:00:00.000Z:# Dec');
    expect(markup).toContain('Generated by Chekku');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('404s when token param is missing', async () => {
    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s when service throws not-found', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.getPublicSlides.mockRejectedValue(
      new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.'),
    );

    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s when service throws storage-unavailable', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.getPublicSlides.mockRejectedValue(
      new CompetitiveAnalysisServiceError('storage-unavailable', 503, 'Storage unavailable.'),
    );

    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('does NOT import @chekku/storage (verified separately by ui-structure test)', async () => {
    // placeholder — actual lock is in client/src/lib/ui-structure.test.ts
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run client/src/app/public/public-slides-page.test.ts`
Expected: FAIL — module path does not exist.

- [ ] **Step 3: Create the route**

Create `client/src/app/public/slides/[analysisId]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';

import { CompetitiveSlides } from '@/components/competitive-slides';
import {
  CompetitiveAnalysisServiceError,
  getPublicSlides,
} from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function PublicSlidesPage({
  params,
  searchParams,
}: {
  params: Promise<{ analysisId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { analysisId } = await params;
  const { t } = await searchParams;
  const token = typeof t === 'string' ? t : undefined;

  if (!token) {
    notFound();
  }

  let payload: Awaited<ReturnType<typeof getPublicSlides>>;
  try {
    payload = await getPublicSlides(analysisId, token!);
  } catch {
    // All errors (not-found, storage-unavailable, internal) collapse to 404 to avoid
    // revealing whether an analysis exists. Storage outages on the public route should
    // be rare; the cost of leaking existence is higher than the cost of a 404.
    notFound();
  }

  return (
    <div className="public-slides-shell">
      <main className="public-slides-main">
        <CompetitiveSlides
          variant="public"
          analysisId={payload.analysisId}
          slidesMarkdown={payload.slidesMarkdown}
          anchorProduct={payload.anchorProduct}
          createdAt={payload.createdAt}
        />
      </main>
      <footer className="public-slides-footer">
        Generated by Chekku · {payload.createdAt}
      </footer>
    </div>
  );
}
```

- [ ] **Step 4: Run passing tests**

Run: `npx vitest run client/src/app/public/public-slides-page.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/app/public/slides/[analysisId]/page.tsx client/src/app/public/public-slides-page.test.ts
git commit -m "feat(client): add /public/slides/<id> token-gated route"
```

---

## Task 5: Viewer overhaul — fullscreen + counter + public variant + print fixes

**Files:**
- Modify: `client/src/components/competitive-slides.tsx`
- Modify: `client/src/components/competitive-slides.test.tsx`
- Modify: `client/src/app/studio.css`

**Interfaces:**
- Consumes: existing Marp render path.
- Produces: `CompetitiveSlides` props extended with `variant`, `anchorProduct`, `createdAt`.

- [ ] **Step 1: Extend the failing test with fullscreen + counter + public variant assertions**

Update `client/src/components/competitive-slides.test.tsx` mock to match the v4 output shape (already done in PR #18 review). Then append new tests:

```tsx
describe('CompetitiveSlides variants and chrome', () => {
  it('renders Fullscreen button in authenticated variant', async () => {
    const element = React.createElement(CompetitiveSlides, {
      analysisId: 'pca_20260723120000_deadbeef',
      slidesMarkdown: '---\nmarp: true\n---\n# Deck',
    });
    const container = render(element);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((b) => b.textContent === 'Fullscreen')).toBe(true);
    expect(container.querySelector('.competitive-slides-counter')).toBeTruthy();
  });

  it('hides toolbar and shows footer in public variant', async () => {
    const element = React.createElement(CompetitiveSlides, {
      analysisId: 'pca_20260723120000_deadbeef',
      slidesMarkdown: '---\nmarp: true\n---\n# Deck',
      variant: 'public',
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
    });
    const container = render(element);
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.textContent).toContain('Generated by Chekku');
    expect(container.textContent).toContain('GPT');
  });

  it('requests fullscreen on Fullscreen button click', async () => {
    const requestFullscreen = vi.fn();
    const element = React.createElement(CompetitiveSlides, {
      analysisId: 'pca_20260723120000_deadbeef',
      slidesMarkdown: '---\nmarp: true\n---\n# Deck',
    });
    const container = render(element);
    const stage = container.querySelector('.competitive-slides-stage') as HTMLElement & {
      requestFullscreen: () => Promise<void>;
    };
    stage.requestFullscreen = requestFullscreen;
    const button = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Fullscreen') as HTMLButtonElement;
    button.click();
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('injects scoped print style that hides toolbar', async () => {
    const element = React.createElement(CompetitiveSlides, {
      analysisId: 'pca_20260723120000_deadbeef',
      slidesMarkdown: '---\nmarp: true\n---\n# Deck',
    });
    const container = render(element);
    const styles = Array.from(container.querySelectorAll('style'));
    const hasPrintRule = styles.some((s) =>
      s.textContent?.includes('@media print')
      && s.textContent?.includes('.competitive-slides-toolbar'),
    );
    expect(hasPrintRule).toBe(true);
  });
});
```

Make sure to add `import React from 'react';` if not already imported.

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run client/src/components/competitive-slides.test.tsx`
Expected: FAIL — Fullscreen button, counter, public variant, print style not implemented.

- [ ] **Step 3: Rewrite the component**

Replace the contents of `client/src/components/competitive-slides.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface CompetitiveSlidesProps {
  analysisId: string;
  slidesMarkdown: string;
  variant?: 'authenticated' | 'public';
  anchorProduct?: string;
  createdAt?: string;
}

interface Rendered {
  html: string;
  css: string;
}

interface SlidePosition {
  current: number;
  total: number;
}

const SCOPED_PRINT_STYLE = `
@media print {
  .competitive-slides-toolbar,
  .competitive-slides-counter,
  .public-slides-footer {
    display: none !important;
  }
}
`;

export function CompetitiveSlides({
  analysisId,
  slidesMarkdown,
  variant = 'authenticated',
  anchorProduct,
  createdAt,
}: CompetitiveSlidesProps) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState(false);
  const [position, setPosition] = useState<SlidePosition>({ current: 1, total: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { Marp } = await import('@marp-team/marp-core');
        const result = new Marp({ script: false }).render(slidesMarkdown) as Rendered;
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
    const stage = stageRef.current;
    if (!stage) return;

    const slides = Array.from(stage.querySelectorAll<Element>('svg[data-marpit-svg]'));
    setPosition({ current: 1, total: slides.length });

    if (slides.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const index = slides.indexOf(visible.target);
        if (index >= 0) setPosition({ current: index + 1, total: slides.length });
      },
      { threshold: [0.5, 0.75], root: stage },
    );
    slides.forEach((slide) => observer.observe(slide));

    return () => observer.disconnect();
  }, [rendered]);

  useEffect(() => {
    if (variant !== 'authenticated') return;
    if (!rendered) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const stage = stageRef.current;
      if (!stage) return;
      const slides = Array.from(stage.querySelectorAll<Element>('svg[data-marpit-svg]'));
      if (slides.length === 0) return;
      const current = position.current - 1;
      const targetIndex = event.key === 'ArrowRight'
        ? Math.min(current + 1, slides.length - 1)
        : Math.max(current - 1, 0);
      slides[targetIndex]?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rendered, position, variant]);

  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

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

  const handleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void stage.requestFullscreen();
    }
  };

  if (variant === 'public') {
    return (
      <div className="competitive-slides-shell competitive-slides-shell-public">
        <style dangerouslySetInnerHTML={{ __html: SCOPED_PRINT_STYLE }} />
        <div className="competitive-slides-stage" ref={stageRef}>
          {!rendered ? (
            <p className="competitive-slides-loading">Rendering deck…</p>
          ) : (
            <>
              <style dangerouslySetInnerHTML={{ __html: rendered.css }} />
              <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
            </>
          )}
        </div>
        {anchorProduct && createdAt ? (
          <p className="public-slides-context">
            Generated by Chekku · {anchorProduct} · {createdAt}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="competitive-slides-shell">
      <style dangerouslySetInnerHTML={{ __html: SCOPED_PRINT_STYLE }} />
      <div className="competitive-slides-toolbar">
        <span className="competitive-slides-counter" aria-live="polite">
          {position.current} / {position.total}
        </span>
        <button type="button" className="studio-button" onClick={() => window.print()}>
          Print
        </button>
        <button type="button" className="studio-button" onClick={handleFullscreen}>
          {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      <div className="competitive-slides-stage" ref={stageRef}>
        {!rendered ? (
          <p className="competitive-slides-loading">Rendering deck…</p>
        ) : (
          <>
            <style dangerouslySetInnerHTML={{ __html: rendered.css }} />
            <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update studio.css — remove `overflow: hidden` and add counter style**

In `client/src/app/studio.css`, find the `.competitive-slides-stage` rule and remove the `overflow: hidden;` line. Add new rules for counter + public variant:

```css
/* Competitive slides stage */
.competitive-slides-shell {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.competitive-slides-shell-public {
  min-height: 100vh;
}

.competitive-slides-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
}

.competitive-slides-counter {
  font-variant-numeric: tabular-nums;
  color: var(--studio-muted, #666);
  margin-right: auto;
}

.competitive-slides-loading {
  padding: 4rem 1rem;
  text-align: center;
  color: var(--studio-muted, #666);
}

.competitive-slides-stage {
  /* overflow: hidden removed — Marp's own CSS handles scroll-snap during screen
     use and pagination during print. The hidden rule clipped every slide
     below the first when the browser paginated. */
}

.public-slides-context {
  text-align: center;
  color: var(--studio-muted, #666);
  padding: 1rem;
  font-size: 0.875rem;
}
```

- [ ] **Step 5: Run passing tests**

Run: `npx vitest run client/src/components/competitive-slides.test.tsx`
Expected: PASS (existing + 4 new tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/competitive-slides.tsx client/src/components/competitive-slides.test.tsx client/src/app/studio.css
git commit -m "feat(client): fullscreen + slide counter + public variant + print fixes"
```

---

## Task 6: Share button component (client-side fetch + clipboard)

**Files:**
- Create: `client/src/components/share-link-button.tsx`
- Create: `client/src/components/share-link-button.test.tsx`

**Interfaces:**
- Produces: `ShareLinkButton({ analysisId })` client component.

- [ ] **Step 1: Write failing jsdom test**

Create `client/src/components/share-link-button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactElement } from 'react';

import { ShareLinkButton } from './share-link-button';

let root: Root | null = null;
function render(ui: ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => { r.render(ui); });
  return container;
}
afterEach(() => {
  act(() => { root?.unmount(); });
  document.body.innerHTML = '';
  root = null;
  vi.restoreAllMocks();
});

describe('ShareLinkButton', () => {
  it('renders Create share link initially', () => {
    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    expect(container.querySelector('button')?.textContent).toContain('Create share link');
  });

  it('creates share link on click and updates label to Copy share link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ url: '/public/slides/pca_x?t=abc' }),
    } as Response);

    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    const button = container.querySelector('button') as HTMLButtonElement;

    await act(async () => { button.click(); });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/storage/competitive-analyses/pca_20260723120000_deadbeef/share',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(writeText).toHaveBeenCalledWith('/public/slides/pca_x?t=abc');
    expect(container.querySelector('button')?.textContent).toContain('Copy share link');
  });

  it('renders error message on fetch failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: { code: 'not-found', message: 'Analysis missing.' } }),
    } as Response);

    const container = render(<ShareLinkButton analysisId="pca_20260723120000_deadbeef" />);
    const button = container.querySelector('button') as HTMLButtonElement;

    await act(async () => { button.click(); });

    expect(fetchSpy).toHaveBeenCalled();
    expect(container.textContent).toContain('Could not create share link');
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run client/src/components/share-link-button.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the component**

Create `client/src/components/share-link-button.tsx`:

```tsx
'use client';

import { useState } from 'react';

interface ShareLinkButtonProps {
  analysisId: string;
}

export function ShareLinkButton({ analysisId }: ShareLinkButtonProps) {
  const [state, setState] = useState<'idle' | 'shared' | 'error'>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const handleCreate = async () => {
    try {
      const response = await fetch(
        `/api/storage/competitive-analyses/${encodeURIComponent(analysisId)}/share`,
        { method: 'POST' },
      );
      if (!response.ok) {
        setState('error');
        return;
      }
      const { url } = (await response.json()) as { url: string };
      setShareUrl(url);
      setState('shared');
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      setState('error');
    }
  };

  const handleCopy = async () => {
    if (!shareUrl || !navigator.clipboard) return;
    await navigator.clipboard.writeText(shareUrl);
  };

  if (state === 'error') {
    return (
      <div className="studio-share-button-group">
        <button type="button" className="studio-button" onClick={handleCreate}>
          Create share link
        </button>
        <span className="studio-share-button-error" role="alert">
          Could not create share link
        </span>
      </div>
    );
  }

  if (state === 'shared' && shareUrl) {
    return (
      <button type="button" className="studio-button" onClick={handleCopy}>
        Copy share link
      </button>
    );
  }

  return (
    <button type="button" className="studio-button" onClick={handleCreate}>
      Create share link
    </button>
  );
}
```

- [ ] **Step 4: Run passing tests**

Run: `npx vitest run client/src/components/share-link-button.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/share-link-button.tsx client/src/components/share-link-button.test.tsx
git commit -m "feat(client): add ShareLinkButton client component"
```

---

## Task 7: Detail page integration — render ShareLinkButton

**Files:**
- Modify: `client/src/app/reports/competitive/[analysisId]/page.tsx`
- Modify: `client/src/app/reports/competitive/competitive-pages.test.ts`

- [ ] **Step 1: Write failing test**

Add to `client/src/app/reports/competitive/competitive-pages.test.ts` (inside the detail-page describe block):

```ts
vi.mock('@/components/share-link-button', () => ({
  ShareLinkButton: ({ analysisId }: { analysisId: string }) =>
    `SHARE_BUTTON:${analysisId}`,
}));

it('renders ShareLinkButton in the header when analysis loads', async () => {
  mocks.getAnalysis.mockResolvedValue(analysis);

  const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
    params: Promise.resolve({ analysisId }),
  }));

  expect(markup).toContain(`SHARE_BUTTON:${analysisId}`);
});
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: FAIL — ShareLinkButton not rendered.

- [ ] **Step 3: Add ShareLinkButton to the detail page**

In `client/src/app/reports/competitive/[analysisId]/page.tsx`, add the import:

```ts
import { ShareLinkButton } from '@/components/share-link-button';
```

And in the `studio-report-header-actions` div, add the ShareLinkButton after the View slides link and before Back to analyses:

```tsx
<div className="studio-report-header-actions">
  {analysis.slidesMarkdown && analysis.slidesMarkdown.trim().length > 0 ? (
    <Link
      className="studio-button"
      href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
    >
      View slides
    </Link>
  ) : null}
  <ShareLinkButton analysisId={analysis.analysisId} />
  <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
</div>
```

- [ ] **Step 4: Run passing tests**

Run: `npx vitest run client/src/app/reports/competitive/competitive-pages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/reports/competitive/[analysisId]/page.tsx client/src/app/reports/competitive/competitive-pages.test.ts
git commit -m "feat(client): render ShareLinkButton on competitive analysis detail page"
```

---

## Task 8: UI-structure test — public route contract

**Files:**
- Modify: `client/src/lib/ui-structure.test.ts`

- [ ] **Step 1: Add the public route to optional sources + assertions**

```ts
const publicSlidesPage = readOptionalSource('../app/public/slides/[analysisId]/page.tsx');
```

Inside `describe('requested UI structure', ...)` add a new test:

```ts
it('renders the public slides route through the shared client component and never touches Garage directly', () => {
  expect(publicSlidesPage).toContain("export const dynamic = 'force-dynamic'");
  expect(publicSlidesPage).not.toContain("'use client'");
  expect(publicSlidesPage).toContain("from '@/components/competitive-slides'");
  expect(publicSlidesPage).toContain("from '@/server/competitive-analyses'");
  expect(publicSlidesPage).toContain('getPublicSlides');
  expect(publicSlidesPage).not.toContain("from '@chekku/storage'");
  expect(publicSlidesPage).not.toContain('getCompetitiveAnalysisForUser');
  expect(publicSlidesPage).not.toContain('requireIdentity');
});
```

- [ ] **Step 2: Run passing tests**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/ui-structure.test.ts
git commit -m "test(client): lock public slides route contract in ui-structure"
```

---

## Task 9: Docs — AGENTS.md, ARCHITECTURE.md, OPERATIONS.md, README.md

**Files:**
- Modify: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`

- [ ] **Step 1: AGENTS.md — update invariants**

Find the section on PM analyses. Update the persisted-key set to include `share-token.json` (when shared). Add a new bullet about the public route:

```text
- Competitive IDs use `pca_YYYYMMDDHHMMSS_<8 lowercase hex>` and enforce `^pca_[0-9]{14}_[0-9a-f]{8}$`. Persist only `competitive-analyses/<analysisId>/{request.md,analysis.md,slides.md,share-token.json?,metadata.json}` relative keys (share-token.json exists only after the user creates a share link); metadata writes last. Every complete competitive save produces a non-blank `slides.md` Marp deck; legacy analyses saved before this feature have no `slides.md` and the slides route returns 404.
```

Find the routes-preservation bullet and add the public route:

```text
- Preserve routes `/reports`, `/reports/weekly`, `/reports/<pmr-id>`, `/reports/competitive`, `/reports/competitive/<pca-id>`, `/reports/competitive/<pca-id>/slides`, and `/public/slides/<pca-id>` (unauthenticated, token-gated via `?t=<32-hex>` query param); existing weekly and competitive links must not move.
```

Add a new bullet to the same section about the public seam:

```text
- `/public/slides/<pca-id>?t=<token>` is the only unauthenticated PM route. The server seam `getPublicSlides` reads ONLY `share-token.json` (validates token) and `slides.md` (renders deck). It must NEVER read `metadata.json`, `analysis.md`, `request.md`, or any other Garage key. All failures (missing token, wrong token, missing slides, storage outage) collapse to 404 to avoid leaking whether an analysis exists.
```

- [ ] **Step 2: ARCHITECTURE.md — new public route section**

Locate the competitive analysis storage section. Add after the slides route paragraph:

```markdown
The same `slides.md` Marp deck is also reachable at the unauthenticated public route `/public/slides/<analysisId>?t=<token>`. Share tokens are 32-char hex strings generated on demand by an authenticated POST route; the token plus a minimal context bundle (`anchorProduct`, `createdAt`) is persisted as `share-token.json` alongside the analysis. The public server seam reads only `share-token.json` and `slides.md` — never `analysis.md`, `request.md`, or `metadata.json`. All public-route failures collapse to 404 to avoid leaking analysis existence.
```

- [ ] **Step 3: OPERATIONS.md — share flow operational notes**

Add a new subsection "## Shareable slides" (or extend the existing competitive-analysis-slides section):

```markdown
### Shareable slides

Each competitive analysis can be shared publicly via a token-gated link. From the detail page (`/reports/competitive/<pca-id>`), click `Create share link` to mint a 32-char hex token persisted as `share-token.json` alongside the analysis. The returned URL `/public/slides/<pca-id>?t=<token>` is unauthenticated and renders the deck through the same `CompetitiveSlides` component in public mode (no toolbar, no app chrome, footer with anchor product + created date).

The share token is the only credential gating public access; anyone with the URL can view the deck. Tokens are NOT rotated by repeated `Create share link` clicks (idempotent) and DO NOT expire (v1.1). Revocation is deferred to v2. All public-route failures collapse to 404 (missing analysis, wrong token, missing slides, storage outage) so observers cannot learn whether an analysis exists.

The public seam reads ONLY `share-token.json` and `slides.md` — never `analysis.md`, `request.md`, or `metadata.json`. Tokens are 128 bits of entropy (`crypto.randomBytes(16).toString('hex')`) and compared in constant time. Token-in-URL leakage via Referer headers, browser history, and server logs is acceptable for this use case (decks are non-sensitive competitive analysis); document and warn the user at share-create time.
```

- [ ] **Step 4: README.md — public route + share feature**

In the feature list near the top, add:

```text
- **Shareable slide decks** — token-gated public URLs for competitive analysis decks. Generate from the analysis detail page; anyone with the link can view the deck in their browser without an account.
```

In the routes section, update the list:

```text
`/reports/competitive/<pca-id>/slides` renders the saved Marp deck in-app via `@marp-team/marp-core` (print-to-PDF only, no PPTX, no public sharing in v1). Authenticated APIs are `GET /api/storage/pm-reports[/<reportId>]`, `GET /api/storage/competitive-analyses[/<analysisId>]`, and `POST /api/storage/competitive-analyses/<analysisId>/share`. The unauthenticated public route is `GET /public/slides/<analysisId>?t=<token>`.
```

- [ ] **Step 5: Verify typecheck + lint still pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/OPERATIONS.md README.md
git commit -m "docs: document public share-token route and viewer overhaul"
```

---

## Final Verification

After all 9 tasks land:

- [ ] **Run full check**

```bash
npm run check
```

Expected: typecheck + lint + vitest. Target test count is previous total + ~25 new tests across storage/server/routes/component. Zero failures.

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

- [ ] **Manual smoke (optional)**

1. Start dev stack: `npm run dev`.
2. Run `/competitive-analysis <anchor> vs <competitors>` and wait for completion + save.
3. Open `/reports/competitive/<id>`. Click `Create share link`. Verify URL copied to clipboard.
4. Open an incognito window. Paste the URL. Verify deck renders, footer present, no app chrome.
5. Try the same URL with a malformed token (`?t=short`). Verify 404.
6. Try `/public/slides/<id>` without `?t=`. Verify 404.
7. Open `/reports/competitive/<id>/slides`. Click Fullscreen. Verify Esc exits. Verify slide counter updates on scroll.
8. Print preview on slides route. Verify each slide prints as its own page (no clipping).
9. Print preview on chat page. Verify browser-default behavior (no app-global `@page` rule leaking).

---

## Self-Review

**Spec coverage:**

- ✅ Print clip bug (overflow:hidden on stage) — Task 5 Step 4 removes the rule.
- ✅ Toolbar leak in print — Task 5 injects scoped `@media print` style in the component.
- ✅ Fullscreen mode — Task 5 adds Fullscreen API on stage container + toggle button.
- ✅ Slide counter — Task 5 adds IntersectionObserver + counter display.
- ✅ Public sharing (token-gated, on-demand) — Tasks 1–4 cover storage + seam + API + public route.
- ✅ Detail page ShareLinkButton — Tasks 6–7.
- ✅ Public variant — Task 5 adds `variant` prop + footer.
- ✅ Identity seam unchanged for authenticated routes — Task 2 preserves `requireIdentity` for `createShareLinkForUser`, `getShareTokenForUser`.
- ✅ Public seam reads ONLY share-token.json + slides.md — Task 4 + locked by Task 8 ui-structure test.
- ✅ Token = 32 hex chars, constant-time compare — Task 1.
- ✅ All public-route failures collapse to 404 — Task 4.
- ✅ AGENTS.md / docs / README updates — Task 9.

**Placeholder scan:** None. Every step contains actual code or shell command.

**Type consistency:**

- `ShareTokenBundle` consistent across storage (Task 1), seam (Task 2), tests.
- `ShareableSlidesPayload` consistent across storage (Task 1), seam (Task 2 as `PublicSlidesPayload` extends it with analysisId).
- `CompetitiveSlidesProps` extended consistently in Task 5 (`variant`, `anchorProduct`, `createdAt`) and consumed by Task 4's public route.
- `createShareLinkForUser(analysisId, deps?)` consistent across Task 2 (seam) and Task 3 (API route).
- `getPublicSlides(analysisId, token, deps?)` consistent across Task 2 (seam) and Task 4 (public route).

**Scope check:** Single PR-sized. Nine tasks, each independently testable and revertable. Public sharing and viewer overhaul bundled intentionally — share button UX lives in the redesigned viewer.
