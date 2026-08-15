import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  asBinaryObjectStorage,
  createLazyGarageObjectStorage,
  createSocialPostStorage,
  getSocialPost,
  readVisualAssetBytes,
  ObjectStorageError,
  type BinaryObjectStorage,
  type ObjectStorage,
} from '@chekku/storage';

import { isImageGenerationClientError } from '../../image-generation/errors.js';
import { imageReviewClient } from '../../image-generation/review-client.js';
import type { ImageReviewClient } from '../../image-generation/types.js';
import { env } from '../../config/env.js';

/**
 * Visual Content Agent — `review_image` tool.
 *
 * Reviews one already-generated visual asset for a social post against a brief
 * (the canonical content + the agreed visual concept) and returns a structured
 * verdict. Used by the Visual Content Agent inside its self-review loop: after
 * `generate_image` succeeds, the agent calls `review_image` once; if the
 * verdict is `fail`, it adjusts the generation prompt using the returned
 * `suggestion` and calls `generate_image` again, up to the regeneration cap.
 *
 * The reviewer is the same fixed image model (`LLM_IMAGE_MODEL`) used for
 * generation, invoked through the chat-completions endpoint with an
 * `image_url` content part (see `agent/src/image-generation/review-client.ts`).
 * Review is advisory and never mutates the image, the post, or the persisted
 * asset — `review_image` is read-only.
 *
 * Security invariants (mirror `generate_image`):
 * - The model id is fixed by `LLM_IMAGE_MODEL` and never comes from input.
 * - The namespace is fixed to `social-media-agent`; the model cannot choose it.
 * - The postId and assetId are validated by regex; no arbitrary object keys.
 * - Provider and storage failures are normalized to fixed safe errors that
 *   never expose credentials, endpoints, response bodies, or diagnostics.
 */

const POST_ID_SCHEMA = z.string().regex(/^smp_[0-9]{14}_[0-9a-f]{8}$/);
const ASSET_ID_SCHEMA = z.string().regex(/^sva_[0-9]{14}_[0-9a-f]{8}$/);
const BRIEF_SCHEMA = z.string().refine(
  (value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 4_000,
  'Brief must be a non-empty string of at most 4,000 UTF-8 bytes.',
);

const inputSchema = z.object({
  postId: POST_ID_SCHEMA,
  assetId: ASSET_ID_SCHEMA,
  brief: BRIEF_SCHEMA,
}).strict();

const outputSchema = z.object({
  postId: z.string(),
  assetId: z.string(),
  score: z.number(),
  issues: z.array(z.string()),
  suggestion: z.string(),
  model: z.string(),
  reviewedAt: z.string(),
}).strict();

export interface ReviewImageToolOptions {
  reviewClient?: ImageReviewClient;
  storeFactory?: () => ObjectStorage;
  /**
   * Server-owned image model id. Defaults to `env.LLM_IMAGE_MODEL`; exposed as
   * a constructor seam (like `reviewClient`/`storeFactory`) so tests do not
   * depend on ambient env. It is never read from tool/model input.
   */
  model?: string;
  now?: () => Date;
}

function socialStore(options: ReviewImageToolOptions): BinaryObjectStorage {
  const root = (options.storeFactory ?? createLazyGarageObjectStorage)();
  return asBinaryObjectStorage(createSocialPostStorage(root));
}

/**
 * Fixed safe messages surfaced through the tool result. The agent reads tool
 * errors verbatim and must not claim success when one is returned; none of
 * these expose credentials, endpoints, object keys, or provider diagnostics.
 */
const SAFE_ERRORS = {
  notConfigured: 'Image review is not configured. Set LLM_IMAGE_MODEL, LLM_BASE_URL, and LLM_API_KEY in agent/.env.',
  notFound: 'Social post not found.',
  assetNotFound: 'Visual asset is not attached to this social post.',
  storage: 'Visual asset storage is unavailable. Try again later.',
} as const;

function requireImageModel(explicit?: string): string {
  const model = (explicit ?? env.LLM_IMAGE_MODEL).trim();
  if (!model) throw new Error(SAFE_ERRORS.notConfigured);
  return model;
}

export function createReviewImageTool(options: ReviewImageToolOptions = {}) {
  const client = options.reviewClient ?? imageReviewClient;
  const now = options.now ?? (() => new Date());

  const tool = createTool({
    id: 'review_image',
    description:
      'Review one already-generated visual asset for a social post against a brief. Returns a score (0-100), concrete issues, and a suggestion you can append to the next generation prompt. Read-only — never mutates the asset. Use after every generate_image call to decide whether to regenerate.',
    inputSchema,
    outputSchema,
    mcp: {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    execute: async ({ postId, assetId, brief }) => {
      requireImageModel(options.model);
      const store = socialStore(options);
      await store.ensureReady?.();

      // Verify the post exists and the asset is attached to it before any
      // provider call. This bounds review to assets the agent actually
      // generated through `generate_image` and prevents arbitrary object key
      // access via a fabricated assetId.
      try {
        const post = await getSocialPost(store, postId);
        const owned = (post.metadata.visualAssets ?? []).some((entry) => entry.assetId === assetId);
        if (!owned) {
          throw new Error(SAFE_ERRORS.assetNotFound);
        }
      } catch (error) {
        if (error instanceof ObjectStorageError && error.code === 'not-found') {
          throw new Error(SAFE_ERRORS.notFound);
        }
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      let bytes;
      try {
        bytes = await readVisualAssetBytes(store, postId, assetId);
      } catch (error) {
        if (error instanceof ObjectStorageError && error.code === 'not-found') {
          throw new Error(SAFE_ERRORS.assetNotFound);
        }
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      // `readVisualAssetBytes` returns `contentType: string`, but the value is
      // always one of the VisualMimeType variants persisted by `generate_image`.
      // Validate at the boundary so a corrupted/foreign blob can never reach
      // the provider as a mismatched MIME.
      const mimeType = bytes.contentType;
      if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
        throw new Error(SAFE_ERRORS.storage);
      }

      let reviewed;
      try {
        reviewed = await client.review({
          imageBytes: bytes.value,
          mimeType,
          brief,
        });
      } catch (error) {
        if (isImageGenerationClientError(error)) {
          throw new Error(error.message);
        }
        throw new Error(SAFE_ERRORS.storage);
      }

      return {
        postId,
        assetId,
        score: reviewed.score,
        issues: reviewed.issues,
        suggestion: reviewed.suggestion,
        model: reviewed.model,
        reviewedAt: now().toISOString(),
      };
    },
  });

  tool.requireApproval = undefined;
  return tool as typeof tool & {
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
  };
}

export const reviewImageTool = createReviewImageTool();
