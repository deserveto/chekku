# Visual Content Agent — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-07-28-visual-content-agent-design.md`
**Branch:** `feat/visual-content-agent`
**Workflow:** Test-driven. For each layer, write the test first where practical,
watch it fail, then implement to green. Run the focused Vitest file after each
layer, then `npm run check` + `npm run build` at the end.

## Phase 0 — Foundation (already done)

- [x] On `main` @ `aac7ab9`; branch `feat/visual-content-agent` created.
- [x] `npm ci` run.
- [x] Design spec written and self-reviewed.

## Phase 1 — Binary object storage (storage workspace)

Bottom-up: storage first so the tool and route can compose it.

- [ ] **1.1** `storage/src/objects.ts` — add `createBytes`, `replaceBytes`,
      `getBytes` to the `ObjectStorage` interface (additive; optional on the
      interface so existing text-only implementations keep typechecking, but
      the garage + namespaced + lazy adapters all implement them).
      - Test first: `storage/src/garage.test.ts` — add binary cases
        (create/read/collision/missing/content-type/sanitized errors/bounded
        reader rejects oversized).
- [ ] **1.2** `storage/src/garage.ts` — implement the three binary methods.
      Reuse `mutate` for create/replace serialization; add a bounded byte
      reader for `getBytes` that stops above `MAX_BINARY_BODY_BYTES` (16 MiB)
      and returns `{ value, contentType }` from the `GetObjectCommand` response.
- [ ] **1.3** `storage/src/namespaced-objects.test.ts` — add binary namespace
      isolation + key-validation tests.
- [ ] **1.4** `storage/src/namespaced-objects.ts` — delegate the three methods
      through `keyFor` / namespace prefix.
- [ ] **1.5** `storage/src/garage.ts` `createLazyGarageObjectStorage` — expose
      the three methods lazily.
- [ ] **1.6** Run `npm run typecheck --workspace @chekku/storage` and the
      storage vitest files.

## Phase 2 — Visual asset metadata (storage workspace)

- [ ] **2.1** `storage/src/social-posts.ts` — add:
      - `SocialVisualAsset` interface.
      - `createVisualAssetId(now)`.
      - `extensionForMimeType` / `keysForVisualAsset(postId, assetId, mimeType)`.
      - `buildVisualAsset(input)` (pure).
      - Extend `SocialPostMetadata` with `visualAssets?` / `activeVisualAssetId?`.
      - Extend `parseSocialPostMetadata` with granular visual parsing (drop
        invalid assets, validate active reference).
      - `attachVisualAsset(store, postId, asset)` (read → append → set active →
        `replaceText` metadata last).
      - `readVisualAssetBytes(store, postId, assetId)` (for the route).
- [ ] **2.2** `storage/src/social-posts.test.ts` — add visual coverage:
      legacy-without-visuals, one visual, multiple revisions (append, not
      overwrite), invalid asset id/mime/key dropped, active-missing unset,
      serialization, parser compatibility, attach ordering, read bytes.
- [ ] **2.3** `storage/src/index.ts` — export the new types/helpers.
- [ ] **2.4** Run storage typecheck + tests.

## Phase 3 — Image-generation provider boundary (agent workspace)

- [ ] **3.1** `agent/src/image-generation/types.ts` —
      `ImageGenerationRequest`, `ImageGenerationResult`, `ImageGenerationClient`.
- [ ] **3.2** `agent/src/image-generation/errors.ts` —
      `ImageGenerationError` with fixed safe categories + messages.
- [ ] **3.3** `agent/src/image-generation/client.test.ts` — full coverage per
      spec §15 (fixed model, request shape, timeout, invalid response, invalid
      base64, missing data, unsupported MIME, oversized, 4xx/5xx/network,
      sanitization, DI).
- [ ] **3.4** `agent/src/image-generation/client.ts` —
      `createOpenAICompatibleImageClient(options)` implementing the OpenAI
      Images API contract against `LLM_BASE_URL` + fixed model, with bounded
      fetch, base64 decode, MIME allowlist, byte cap, safe errors. Default
      export `imageClient` constructed from `env`.
- [ ] **3.5** Run the client test file.

## Phase 4 — `generateImageTool` (agent workspace)

- [ ] **4.1** `agent/src/mastra/tools/generate-image.test.ts` — full coverage
      per spec §15 (stable id, schemas, fixed model, approved succeeds, DRAFT
      rejected, unknown rejected, model cannot select key/namespace, image
      stored before metadata, metadata unchanged on generation/upload failure,
      safe errors, revision → new asset + old preserved).
- [ ] **4.2** `agent/src/mastra/tools/generate-image.ts` —
      `createGenerateImageTool({ imageClient, storeFactory, now })` +
      `generateImageTool` default export. Tool id `generate_image`. Loads post,
      verifies `APPROVED`, calls client, generates id/key, stores bytes,
      attaches metadata last, returns asset metadata.
- [ ] **4.3** Run the tool test file.

## Phase 5 — Visual Content Agent (agent workspace)

- [ ] **5.1** `agent/src/agents/__tests__/visual-content-agent.test.ts` —
      coverage per spec §15 (id/name, Mastra registration, memory, processor
      order, exactly `{ generate_image }`, no Telegram, no Garage MCP,
      instruction anchors).
- [ ] **5.2** `agent/src/agents/visual-content-agent.ts` — code-defined agent
      with memory + `[createAgentContextLimiter(), gatewayCompatibilityProcessor,
      createCharBudgetGuard()]`, `tools: { generateImageTool }`,
      `defaultOptions: { maxSteps: 6 }`, focused instructions.

## Phase 6 — Supervisor wiring + Mastra registration (agent workspace)

- [ ] **6.1** `agent/src/agents/social-media-supervisor-agent.ts` — import +
      attach `visualContentAgent`; update description + instructions for
      three-way routing and on-demand visual generation.
- [ ] **6.2** `agent/src/mastra/index.ts` — register `visualContentAgent` in
      the top-level `agents` map.
- [ ] **6.3** Update `agent/src/__tests__/agent-routes.test.ts` and
      `agent/src/agents/__tests__/both-agents.test.ts` to assert the new agent
      and supervisor sub-agent wiring.
- [ ] **6.4** Run agent typecheck + the affected test files.

## Phase 7 — Stable image URL route (client workspace)

- [ ] **7.1** `client/src/server/social-posts.ts` — add
      `getSocialPostVisualAssetForUser(postId, assetId, deps)` returning
      `{ value: Uint8Array, contentType }`; reuse identity seam + canonical id
      validation + safe error mapping. Add DI seam.
- [ ] **7.2** `client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.test.ts` —
      coverage per spec §15.
- [ ] **7.3** `client/src/app/api/storage/social-posts/[postId]/visuals/[assetId]/route.ts` —
      `GET` handler: identity → validate ids → load asset → respond with bytes
      + correct `Content-Type` + cache headers; safe errors.
- [ ] **7.4** Run the route test file + client typecheck + lint.

## Phase 8 — Environment + docs

- [ ] **8.1** `agent/src/config/env.ts` — add `LLM_IMAGE_MODEL` (default
      `gemini-3.1-flash-image`) and `LLM_IMAGE_ENDPOINT_PATH` (default
      `/images/generations`).
- [ ] **8.2** `agent/.env.example` — document both variables.
- [ ] **8.3** `scripts/setup-env.sh` — add an optional prompt for
      `LLM_IMAGE_MODEL` (default kept) so reruns preserve it; add it to the
      optional-integrations summary.
- [ ] **8.4** `docs/OPERATIONS.md` — document the two variables + the
      on-demand/approval workflow + troubleshooting for "Image generation is
      not configured."
- [ ] **8.5** `docs/ARCHITECTURE.md` — add the Visual Content Agent to the
      agent list, the social network diagram, the storage section (binary
      objects + visual layout), the public routes section, and the extension
      points.
- [ ] **8.6** `README.md` — highlights + agent network diagram + env table +
      core rules entry.
- [ ] **8.7** `AGENTS.md` — add the Visual Content Agent invariant section and
      the binary storage / visual metadata rules.

## Phase 9 — Verification

- [ ] **9.1** `npm run typecheck` (all three workspaces).
- [ ] **9.2** `npm run lint` (client).
- [ ] **9.3** `npm test` (full Vitest).
- [ ] **9.4** `npm run check` (the combined gate).
- [ ] **9.5** `npm run build` (Mastra + Next.js production build).
- [ ] **9.6** `git diff --check` (no whitespace errors).
- [ ] **9.7** Final report (per task §22), explicitly flagging the OpenAI
      Images API contract as the one external dependency pending live
      verification.
