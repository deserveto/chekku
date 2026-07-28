# Visual Content Agent — Design Specification

**Date:** 2026-07-28
**Branch:** `feat/visual-content-agent`
**Status:** Ready for implementation

## 1. Purpose

Add a **Visual Content Agent** (`visual-content-agent`) to Chekku's Social Media
Agent Network. It is a code-defined Mastra sub-agent under the
`social-media-supervisor-agent` that generates on-demand images for an
**approved** social post, stores the image bytes in the existing Garage object
storage, attaches the resulting asset to the canonical social-post metadata,
and exposes the image through a stable application-facing URL.

Image generation is **on-demand only**: it never runs automatically after the
Content Writer finishes or inside the `weekly-social-drafts` workflow.

## 2. Current architecture (as inspected on `main` @ `aac7ab9`)

The Social Media Agent Network today is:

```text
User
  └── social-media-supervisor-agent (no tools; routes via `agents` field)
        ├── social-media-content-writer  (Telegram + email tools; drafts)
        └── social-media-strategist-agent (search_web + read_web_page; planning)
```

Relevant existing boundaries this work composes:

- **Canonical content model:** `storage/src/social-posts.ts` —
  `SocialPostMetadata` is the canonical content boundary for social posts
  (the meeting term "Canonical Content Unit" maps to a social post record).
  Posts live under the fixed Garage namespace `social-media-agent`
  (`SOCIAL_MEDIA_AGENT_ID`), with the layout
  `social-posts/<postId>/{post.md, brief.md, metadata.json}`. IDs use
  `smp_YYYYMMDDHHMMSS_<8 lowercase hex>`. The module exposes only pure
  canonical helpers + read helpers; the weekly workflow is the sole post
  *writer* (via Garage MCP `create_text_object`).
- **Object storage contract:** `storage/src/objects.ts` defines
  `ObjectStorage` with **text-only** methods (`createText`, `replaceText`,
  `getText`, `exists`, `delete`, `listKeys`). `storage/src/garage.ts`
  implements it over S3-compatible Garage; `storage/src/namespaced-objects.ts`
  adds the `agents/<base64url(agentId)>/<relative-key>` physical prefix.
- **Model gateway:** `agent/src/mastra/gateways/openai-compatible.ts` — one
  provider-neutral OpenAI-compatible gateway. `getServerModel()` resolves the
  orchestration model. Configuration uses only `LLM_BASE_URL`, `LLM_API_KEY`,
  `LLM_DEFAULT_MODEL`, `LLM_DISPLAY_NAME`, `LLM_MODELS`.
- **Bounded client pattern:** `agent/src/mastra/web-reader/client.ts` is the
  reference for a dependency-injectable, bounded HTTP provider client (fixed
  endpoint, fixed headers, timeout, size cap, response normalization, safe
  fixed errors that never leak credentials/endpoints/bodies).
- **Tool pattern:** `agent/src/mastra/tools/pm-report-tools.ts` shows the
  factory-with-DI shape (`createSavePmReportToGarageTool(options)` with
  `storeFactory` and `now`) used for tools that compose `@chekku/storage`.
- **Server read boundary:** `client/src/server/social-posts.ts` +
  `client/src/app/api/storage/social-posts/[postId]/route.ts` mirror the PM
  report boundary: identity seam → canonical ID validation → namespaced
  storage read → safe bounded errors.

### Mapping: meeting terminology → repository terminology

| Meeting term | Repository reality |
| --- | --- |
| Canonical Content Unit | `SocialPostMetadata` in `storage/src/social-posts.ts` |
| content ID | `postId` (canonical `smp_...`) — the tool input uses `postId`, not a new `contentId` |
| APPROVED status | `SocialPostStatus === 'APPROVED'` |
| Visual asset | new `SocialVisualAsset` added additively to `SocialPostMetadata` |

## 3. Proposed components

```text
User
  └── social-media-supervisor-agent
        ├── social-media-content-writer
        ├── social-media-strategist-agent
        └── visual-content-agent                 ← NEW
              └── generate_image tool            ← NEW
                    ├── ImageGenerationClient    ← NEW (provider boundary)
                    │     └── POST {LLM_BASE_URL}/images/generations
                    │           model = LLM_IMAGE_MODEL (gemini-3.1-flash-image)
                    ├── Garage binary storage     ← EXTENDED (createBytes/getBytes)
                    └── social-post metadata      ← EXTENDED (visualAssets)
                          └── served by GET /api/storage/social-posts/[postId]/visuals/[assetId]
```

New and extended files (full list in §11):

- `agent/src/image-generation/{client.ts,types.ts,errors.ts,client.test.ts}` — provider boundary.
- `agent/src/mastra/tools/{generate-image.ts,generate-image.test.ts}` — the tool.
- `agent/src/agents/visual-content-agent.ts` + `__tests__/visual-content-agent.test.ts`.
- `storage/src/objects.ts`, `garage.ts`, `namespaced-objects.ts`, `social-posts.ts` — binary + visual-asset support.
- `client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.ts` + server helper + tests.
- `agent/src/mastra/index.ts`, `agent/src/agents/social-media-supervisor-agent.ts`, `agent/src/config/env.ts`, `agent/.env.example`, `scripts/setup-env.sh`, docs.

## 4. Image-generation gateway contract

### Constraint

The repository contains **no image-generation endpoint contract** (verified:
no occurrences of `/images/generations`, `gemini-3.1-flash-image`,
`LLM_IMAGE_MODEL`, `generateImage`, or `generate_image` anywhere in the tree),
and this environment cannot reach the live RafiqSpace gateway to verify the
contract. Per the task's "Gateway Contract Rule", the design must not silently
guess a proprietary response schema.

### Resolution

The RafiqSpace gateway is documented (`.env.example`, README) as an
**OpenAI-compatible** endpoint at `LLM_BASE_URL` ending in `/v1`. The
**OpenAI Images API** (`POST /v1/images/generations`) is the canonical,
publicly-documented standard contract for OpenAI-compatible gateways that
support image generation — it is not a guess at a proprietary schema.

Therefore:

1. Define a clean `ImageGenerationClient` interface (`generate(request)` →
   `{ imageBytes: Uint8Array, mimeType, ... }`).
2. Implement a concrete `createOpenAICompatibleImageClient` that targets the
   standard OpenAI Images API contract:
   - `POST {LLM_BASE_URL}/images/generations` (path configurable via optional
     `LLM_IMAGE_ENDPOINT_PATH`, default `/images/generations`).
   - Request body: `{ model, prompt, n: 1, size, response_format: 'b64_json' }`
     (model fixed from `LLM_IMAGE_MODEL`, never from model input).
   - Response: `{ data: [{ b64_json }] }` (also tolerates `{ data: [{ url }] }`
     by fetching the URL through the same bounded fetch with redirect rejected,
     but `b64_json` is the primary path so no second hop is needed).
3. Use only existing `LLM_BASE_URL` + `LLM_API_KEY`. No second key.
4. Fail closed with a fixed `"Image generation is not configured."` error when
   `LLM_IMAGE_MODEL` is unset/blank or the gateway base/key is missing.
5. The endpoint path is a narrowly-scoped server-only variable
   (`LLM_IMAGE_ENDPOINT_PATH`) so an operator can repoint it if RafiqSpace
   exposes images under a different path, without code changes.
6. Every layer below the client (tool, storage, metadata, route, agent) is
   fully exercised through dependency injection using a test-double client, so
   the entire pipeline is verifiable independent of live gateway availability.
7. The concrete HTTP adapter is clearly documented (code comments + §Gateway
   Contract in the final report) as **assuming the OpenAI Images API standard
   contract and pending live verification against RafiqSpace**. If the live
   gateway does not implement that contract, only the single concrete adapter
   file needs adjustment — nothing else.

### Provider boundary rules (mirroring `web-reader/client.ts`)

- Server-owned `LLM_BASE_URL`, `LLM_API_KEY`, fixed model `LLM_IMAGE_MODEL`.
- **Never** accept model id, endpoint, headers, credentials, or approval from
  model/tool input.
- Bounded timeout (60 s; image generation is slower than text).
- Stop response bodies above 16 MiB (images are larger than text; well below
  S3/Garage limits and the tool's own byte cap).
- Validate response structure; validate base64 decodes; validate the decoded
  payload is non-empty and within the byte cap.
- Allowlist output MIME types (`image/png`, `image/jpeg`, `image/webp`).
- Normalize every provider failure into fixed safe errors
  (`configuration`, `timeout`, `cancelled`, `unavailable`, `format`, `tooLarge`,
  `invalid`) that never expose keys, endpoints, headers, response bodies,
  diagnostics, or request IDs.
- Dependency-injectable `fetch`, `timeoutMs`, `now`.

## 5. Binary Garage storage strategy

### Decision: extend `ObjectStorage` additively with binary methods

The current `ObjectStorage` is text-only. Adding binary methods alongside the
text methods (rather than a parallel `BinaryObjectStorage` hierarchy) is the
**smallest coherent change that follows existing Garage boundaries**: one
interface, one garage adapter, one namespaced wrapper, backward-compatible.

New methods on `ObjectStorage` (all additive; existing text methods unchanged):

```ts
createBytes(key: string, value: Uint8Array, contentType?: string): Promise<void>;
replaceBytes(key: string, value: Uint8Array, contentType?: string): Promise<void>;
getBytes(key: string): Promise<{ value: Uint8Array; contentType?: string }>;
```

- `createBytes` fails on collision (`already-exists`), mirroring `createText`.
- `replaceBytes` requires the object to exist (`not-found`).
- `getBytes` returns the bytes and the stored `Content-Type` (the image route
  needs it to serve the correct MIME).
- Garage adapter: `PutObjectCommand` already accepts `Uint8Array` as `Body`;
  `GetObjectCommand`'s streaming `Body` is read into a bounded `Uint8Array`
  (rejecting bodies above a hard cap, mirroring the web-reader bounded-reader
  pattern). Errors flow through the existing `translateError` sanitizer.
- Namespaced wrapper delegates all three through the same
  `agents/<base64url>/<relative-key>` prefix and key validation.
- `createLazyGarageObjectStorage` exposes the three new methods lazily.

### Namespace

All visual assets live under the **historical `social-media-agent`** namespace
(via `createSocialPostStorage(root)`), **not** under `visual-content-agent`.
This is required so the existing social-post read path
(`client/src/server/social-posts.ts`) can read visuals through the same
namespaced store it already uses for posts.

### Object key layout

```text
social-posts/<postId>/visuals/<assetId>.<ext>
```

- `<postId>`: canonical `smp_...`.
- `<assetId>`: canonical `sva_YYYYMMDDHHMMSS_<8 lowercase hex>` (matches the
  repo's `pmr_`/`pca_`/`smp_` convention; `sva` = social visual asset).
- `<ext>`: derived from the asset's MIME type (`png` | `jpg` | `webp`).
- The tool generates the asset id and object key server-side; the model never
  chooses either.

### What stays unchanged

- Generic Garage MCP remains exactly five text tools. No binary tool is added
  to the MCP registry (security requirement #17/#18).
- Existing text storage methods and all existing storage tests remain
  backward-compatible (additive change only).
- Unknown S3 errors remain sanitized through the existing `translateError`.

## 6. Canonical Content integration (visual metadata)

### Additive, backward-compatible extension to `SocialPostMetadata`

```ts
export interface SocialVisualAsset {
  assetId: string;            // sva_YYYYMMDDHHMMSS_<8 lowercase hex>
  objectKey: string;          // social-posts/<postId>/visuals/<assetId>.<ext>
  imageUrl: string;           // /api/storage/social-posts/<postId>/visuals/<assetId>
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  generatedAt: string;        // RFC3339
  model: string;              // gemini-3.1-flash-image
  prompt: string;             // bounded prompt that produced the image
  width?: number;
  height?: number;
}

export interface SocialPostMetadata {
  // ...existing fields unchanged...
  visualAssets?: SocialVisualAsset[];
  activeVisualAssetId?: string;
}
```

### Parser behavior (`parseSocialPostMetadata`)

The existing parser is strict (returns `undefined` for any malformed post,
skipping it in lists). For visual assets the parser is **granular** so a bad
asset does not poison an otherwise-valid post:

- `visualAssets` missing/not-an-array → treat as no visuals (post stays valid).
- Each entry validated: canonical `sva_` id, allowed MIME, object key matches
  the expected `keysForVisualAsset(postId, assetId, mimeType)` shape, valid
  RFC3339 `generatedAt`, non-empty `model`, bounded `prompt`, `imageUrl`
  matches the expected application route. Invalid entries are **dropped**;
  valid entries are kept in original order.
- `activeVisualAssetId`, when present, must reference a kept asset; otherwise
  it is unset (dropped from the projected metadata).
- Metadata **never** contains base64 image data or Garage credentials.

### Write helper (new, scoped to visual assets)

AGENTS.md forbids a *post* write helper that takes an `ObjectStorage` (the
weekly workflow owns post creation via MCP). Visual-asset attachment is a
**new, separately-scoped capability** that the task explicitly routes through
the tool, so it is not covered by that constraint. `social-posts.ts` gains:

- `createVisualAssetId(now)` → `sva_...`.
- `extensionForMimeType(mimeType)` → `'png' | 'jpg' | 'webp'`.
- `keysForVisualAsset(postId, assetId, mimeType)` → `{ objectKey, imageUrl }`.
- `buildVisualAsset(input)` → pure builder (no storage).
- `attachVisualAsset(store, postId, asset)` → read metadata → append asset →
  set active → `replaceText(metadataObjectKey, newJson)` **last** (so a failed
  image upload never becomes a live metadata entry).
- `readVisualAssetBytes(store, postId, assetId)` → loads metadata, finds the
  asset, returns `{ value: Uint8Array, contentType }` for the route.

### Revision behavior

Image editing is out of scope. A revision:

1. Generates a completely new image.
2. Creates a new `sva_` asset id and new object key.
3. Stores under the new key.
4. **Preserves** the previous asset in `visualAssets`.
5. **Appends** the new asset.
6. Sets the new asset as `activeVisualAssetId`.

No overwrite, no inpainting, no image-to-image.

## 7. `generateImageTool`

- **Stable tool id:** `generate_image`.
- **Export:** `generateImageTool` (plus `createGenerateImageTool(options)`
  factory with DI for `imageClient`, `storeFactory`, `now`).
- **Input (Zod, strict):**
  ```ts
  {
    postId: string;                          // canonical smp_...
    prompt: string;                          // 1..2_000 UTF-8 bytes
    aspectRatio?: '1:1' | '4:5' | '9:16' | '16:9';
    imageSize?: '1K' | '2K';
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  }
  ```
  The model **cannot** supply: model name, namespace, object key, Garage
  credentials, gateway credentials, endpoint URLs, or approval status.
- **Output (Zod, strict):**
  ```ts
  {
    postId: string;
    assetId: string;
    objectKey: string;
    imageUrl: string;
    mimeType: string;
    model: string;
    generatedAt: string;
    width?: number;
    height?: number;
  }
  ```
- **Responsibilities (in order):**
  1. Validate input (Zod).
  2. Load the social post via `createSocialPostStorage(root)` +
     `getSocialPost(store, postId)`.
  3. **Verify** `metadata.status === 'APPROVED'`; reject `DRAFT` (and
     `PUBLISHED` for this iteration) with a fixed safe error.
  4. Call the injected `ImageGenerationClient` with the fixed model
      (`LLM_IMAGE_MODEL`), bounded prompt, and chosen options. The client
      validates bytes/MIME/size and returns normalized output.
  5. Generate `assetId` server-side (`createVisualAssetId(now)`).
  6. Generate the object key server-side (`keysForVisualAsset`).
  7. `store.createBytes(objectKey, imageBytes, mimeType)` — **image stored
     before metadata is touched**.
  8. `attachVisualAsset(store, postId, asset)` — metadata written **last**; if
     it fails, the orphan image bytes are harmless (no canonical entry).
  9. Return the asset metadata.
- MCP annotations: `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: false`, `openWorldHint: true`. No approval gate (matches the
  repo convention — Garage/email/browser actions all run directly).
- The tool is registered **only** on `visual-content-agent`. It is **not** added
  to `storedAgentTools`, `garageMcpServer`, `searxngMcpServer`,
  `webReaderMcpServer`, or any stored-agent registry.

## 8. Stable image URL

### Route

```text
GET /api/storage/social-posts/[postId]/visuals/[assetId]
```

Implemented as a nested Next.js dynamic route at
`client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.ts`.

### Behavior

1. Require the server identity seam (`getUserId`) — mirrors
   `getSocialPostForUser`.
2. Validate `postId` against `^smp_[0-9]{14}_[0-9a-f]{8}$` and `assetId`
   against `^sva_[0-9]{14}_[0-9a-f]{8}$`.
3. Load metadata; verify the asset id belongs to `postId`'s `visualAssets`
   (rejects arbitrary object keys from URL parameters).
4. Read bytes via `readVisualAssetBytes(store, postId, assetId)`.
5. Respond with `200`, the correct `Content-Type` from the asset's mimeType,
   and a short immutable cache (`Cache-Control: public, max-age=300`) — the
   asset id is content-addressed by timestamp+random, so a given id never
   changes.
6. Map `ObjectStorageError`/service errors to safe `400 | 403 | 404 | 503`
   responses; never expose Garage credentials, endpoints, or diagnostics.
7. Never accepts an arbitrary object key — only canonical `sva_` asset ids
   that are verified against metadata.

## 9. Visual Content Agent

```text
ID:   visual-content-agent
Name: Visual Content Agent
Type: code-defined Mastra sub-agent (and top-level registered agent)
```

- Orchestration model: `getServerModel()` (the normal server language model).
  **Not** `gemini-3.1-flash-image` — the image model is invoked only inside
  `generateImageTool`.
- `memory: createAgentMemory()`.
- `inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor,
  createCharBudgetGuard()]` — guard last, after the gateway compatibility
  processor (matches the Content Writer / QA agent pattern).
- `requestContextSchema: providerContextSchema`.
- `tools: { generateImageTool }` — exactly one tool. No generic Garage MCP.
- No Telegram channel, no slash commands.
- `defaultOptions: { maxSteps: 6 }` (small loop: draft prompt → call tool →
  report; revisions are separate turns).

### System instructions (required content)

The instructions must state:

- Handles image/illustration generation only.
- Receives tasks delegated by the Social Media Supervisor.
- Uses the **approved** social post as source context; refuses visuals for
  content that is not approved (the tool enforces this, but the agent should
  not attempt to bypass it).
- **Never** automatically generate an image after content writing — only when
  explicitly requested.
- Converts content intent into a concise visual-generation prompt; preserves
  factual details; avoids adding unverified claims or text overlays.
- Uses `generate_image` for generation.
- Never claims success unless the tool succeeds.
- Returns the `postId`, `assetId`, and `imageUrl`.
- A revision is a **regeneration** (new asset id, new key, old asset
  preserved) — never an edit.
- Never claims to publish content.
- Never rewrites the caption unless the user explicitly asks for a separate
  writing operation (that belongs to the Content Writer).
- Never exposes internal storage keys or credentials.

## 10. Supervisor wiring

`social-media-supervisor-agent.ts` gains a third sub-agent:

```ts
agents: {
  socialMediaContentWriter,
  socialMediaStrategistAgent,
  visualContentAgent,
}
```

Updated instructions route:
- drafting/rewriting/repurposing/caption/platform-formatting → Content Writer;
- strategy/brief/content-plan/audience research → Strategist;
- image/illustration/visual asset/thumbnail/artwork/post visuals → Visual
  Content Agent;
- **visual generation only after an explicit user request** — the supervisor
  must not auto-dispatch the Visual Content Agent when the Content Writer
  finishes;
- forward the `postId` unchanged; never fabricate approval status (the tool
  verifies from persisted state).

## 11. Files changed

**Agent**
- `agent/src/agents/visual-content-agent.ts` (new)
- `agent/src/agents/__tests__/visual-content-agent.test.ts` (new)
- `agent/src/agents/social-media-supervisor-agent.ts` (extended)
- `agent/src/mastra/index.ts` (register `visualContentAgent`)

**Tool / provider**
- `agent/src/image-generation/types.ts` (new)
- `agent/src/image-generation/errors.ts` (new)
- `agent/src/image-generation/client.ts` (new)
- `agent/src/image-generation/client.test.ts` (new)
- `agent/src/mastra/tools/generate-image.ts` (new)
- `agent/src/mastra/tools/generate-image.test.ts` (new)

**Storage**
- `storage/src/objects.ts` (additive binary methods)
- `storage/src/garage.ts` (binary implementation + bounded reader)
- `storage/src/namespaced-objects.ts` (binary delegation)
- `storage/src/social-posts.ts` (visual asset types, helpers, parser)
- `storage/src/garage.test.ts` (binary coverage)
- `storage/src/namespaced-objects.test.ts` (binary coverage)
- `storage/src/social-posts.test.ts` (visual coverage)
- `storage/src/index.ts` (new exports)

**Client / API**
- `client/src/server/social-posts.ts` (visual read helper + DI)
- `client/src/server/social-posts.test.ts` (new — none existed; covers visual read)
- `client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.ts` (new)
- `client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.test.ts` (new)

**Configuration / docs**
- `agent/src/config/env.ts` (`LLM_IMAGE_MODEL`, `LLM_IMAGE_ENDPOINT_PATH`)
- `agent/.env.example`
- `scripts/setup-env.sh`
- `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`

**Tests touched (registry)**
- `agent/src/__tests__/agent-routes.test.ts`
- `agent/src/agents/__tests__/both-agents.test.ts`

## 12. Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LLM_IMAGE_MODEL` | No | `gemini-3.1-flash-image` | Fixed image model invoked by `generate_image`. Empty → tool fails closed. |
| `LLM_IMAGE_ENDPOINT_PATH` | No | `/images/generations` | Narrowly-scoped path under `LLM_BASE_URL` for image generation. |

No second API key. No `NEXT_PUBLIC_*` image variables. `LLM_IMAGE_MODEL` flows
through `setup-env.sh` → `agent/.env` → `agent/.env.development` automatically
(it is an `LLM_`-prefixed value, not filtered by the dev-env renderer).

## 13. Failure handling

- **Image client failures** → fixed safe errors; the tool surfaces them as
  tool errors (the agent must not claim success). The image is **not** stored
  and metadata is **not** updated.
- **Upload failure** (`createBytes`) → tool error; metadata unchanged.
- **Metadata write failure** (`attachVisualAsset`) → tool error; an orphan
  image byte object may exist but is not reachable through canonical metadata
  or the application route (no `sva_` id in any `visualAssets` list).
- **Unapproved/DRAFT content** → fixed `"Social post is not approved..."` tool
  error; no provider call, no storage access.
- **Unknown postId** → fixed `"Social post not found."` tool error.
- **Route failures** → safe `400 | 403 | 404 | 503`; no credential leakage.
- **Configuration missing** (`LLM_IMAGE_MODEL`/`LLM_API_KEY`/`LLM_BASE_URL`) →
  fixed `"Image generation is not configured."` tool error; server boots fine.

## 14. Security boundaries (mapped to requirements)

1. Secrets server-side only (`LLM_API_KEY`, Garage creds never in browser code). ✅
2. Model cannot choose provider endpoint (fixed `LLM_BASE_URL` + optional
   server-only path). ✅
3. Model cannot choose image model (fixed `LLM_IMAGE_MODEL`). ✅
4. Model cannot choose namespace (fixed `social-media-agent` via
   `createSocialPostStorage`). ✅
5. Model cannot choose object key (server-generated `sva_` + layout). ✅
6. Model cannot supply approval status (tool reads persisted metadata). ✅
7. Model cannot supply Garage credentials. ✅
8. Provider errors sanitized (fixed messages). ✅
9. Storage errors sanitized (existing `translateError`). ✅
10. Image response size bounded (client 16 MiB cap; tool enforces byte cap). ✅
11. Prompt size bounded (≤ 2_000 UTF-8 bytes). ✅
12. MIME types allowlisted (`png`/`jpeg`/`webp`). ✅
13. Canonical identifiers validated (`smp_`/`sva_` regex everywhere). ✅
14. Metadata written last. ✅
15. Browser code never imports server storage/S3 clients (route is server-only
    `client/src/server/social-posts.ts`). ✅
16. No base64 in metadata (bytes live as binary objects). ✅
17. Image tool not in stored-agent registry. ✅
18. Garage MCP unchanged at five tools. ✅
19. No generic binary fetch route (only canonical `sva_` ids verified against
    metadata). ✅
20. No logging of provider responses, image bytes, base64, auth headers, or
    private prompts. ✅

## 15. Test strategy (TDD)

Tests are written **before** or alongside implementation, using the existing
Vitest + DI patterns (in-memory `ObjectStorage`, `vi.fn()` fetch, factory
options). Coverage by module:

- **`image-generation/client.test.ts`**: fixed model, request normalization,
  timeout, invalid response, invalid base64, missing data, unsupported MIME,
  oversized response, 4xx/5xx/network failure, secret+endpoint sanitization,
  DI.
- **Storage (`garage.test.ts`, `namespaced-objects.test.ts`,
  `social-posts.test.ts`)**: binary create/read/collision/missing/content-type,
  namespace isolation, invalid keys, sanitized errors, existing text methods
  still pass; visual metadata legacy/one/many-revisions/invalid-asset/
  invalid-mime/invalid-key/active-missing/serialization/parser/append-not-
  overwrite; visual asset read helpers.
- **`generate-image.test.ts`**: stable tool id, input/output schema, fixed
  model, approved succeeds, DRAFT rejected, unknown rejected, model cannot
  select key/namespace, image stored before metadata, metadata unchanged on
  generation failure, metadata unchanged on upload failure, safe errors,
  revision → new asset + old preserved.
- **`visual-content-agent.test.ts`**: stable id/name, Mastra registration,
  memory present, processors in correct order (token-limiter,
  gateway-compat, char-budget-guard last), exactly `{ generate_image }`,
  no Telegram, no Garage MCP dependency, instructions cover on-demand/
  approved-only/no-auto/no-publish/revision=regeneration.
- **Supervisor (extend `both-agents.test.ts`)**: three sub-agents attached,
  instructions route visual→VCA, drafting→Writer, strategy→Strategist,
  supervisor does not claim to generate images, instructions forbid auto-gen.
- **Route `route.test.ts`**: valid asset + correct content-type, invalid
  postId, invalid assetId, asset-not-in-post, missing asset, Garage
  unavailable, no credential leakage, arbitrary object keys rejected.

## 16. Non-goals (explicit)

Automatic generation after Content Writer or in the weekly workflow; image
editing / image-to-image / inpainting / mask editing / image upload; multiple
image providers; platform-specific publishing (Instagram/LinkedIn/Medium); a
platform-specific social agent; major UI redesign; a general-purpose public
Garage file browser; arbitrary user-defined image models; migration of existing
posts; unrelated refactoring; allowing `PUBLISHED` posts to generate (deferred).

## 17. Verification plan

- `npm run typecheck --workspace @chekku/storage`
- `npm run typecheck --workspace agent`
- `npm run typecheck --workspace client`
- `npm run lint --workspace client`
- `npx vitest run <each new/changed test file>` during development
- `npm run check` (full typecheck + lint + tests)
- `npm run build`
- `git diff --check`

The image-generation HTTP adapter cannot be exercised against the live
RafiqSpace gateway from this environment; all adapter behavior is verified
through DI test doubles, and the assumed OpenAI Images API contract is
flagged in the final report as the single external dependency pending live
verification.
