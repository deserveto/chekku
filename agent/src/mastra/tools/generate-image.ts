import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  asBinaryObjectStorage,
  buildVisualAsset,
  createLazyGarageObjectStorage,
  createSocialPostStorage,
  getSocialPost,
  attachVisualAsset,
  ObjectStorageError,
  type BinaryObjectStorage,
  type ObjectStorage,
} from '@chekku/storage';

import { isImageGenerationClientError } from '../../image-generation/errors.js';
import { imageClient } from '../../image-generation/client.js';
import type { ImageGenerationClient } from '../../image-generation/types.js';
import { env } from '../../config/env.js';

/**
 * Visual Content Agent — `generate_image` tool.
 *
 * Generates one image for an APPROVED social post on demand, stores the binary
 * bytes in Garage under the historical `social-media-agent` namespace, and
 * attaches the resulting asset to the post's canonical metadata. The metadata
 * write is the last step, so a generation or upload failure never produces a
 * canonical entry that points at missing bytes.
 *
 * Security invariants:
 * - The model id is fixed by `LLM_IMAGE_MODEL` and never comes from input.
 * - The namespace is fixed to `social-media-agent`; the model cannot choose it.
 * - The asset id and object key are generated server-side; the model cannot
 *   choose them.
 * - Approval status is read from persisted metadata; the model cannot supply
 *   it.
 * - Provider and storage failures are normalized to fixed safe errors that
 *   never expose credentials, endpoints, response bodies, or diagnostics.
 */

const POST_ID_SCHEMA = z.string().regex(/^smp_[0-9]{14}_[0-9a-f]{8}$/);
const PROMPT_SCHEMA = z.string().refine(
  (value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 2_000,
  'Prompt must be a non-empty string of at most 2,000 UTF-8 bytes.',
);

const inputSchema = z.object({
  postId: POST_ID_SCHEMA,
  prompt: PROMPT_SCHEMA,
  aspectRatio: z.enum(['1:1', '4:5', '9:16', '16:9']).optional(),
  imageSize: z.enum(['1K', '2K']).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
}).strict();

const outputSchema = z.object({
  postId: z.string(),
  assetId: z.string(),
  objectKey: z.string(),
  imageUrl: z.string(),
  mimeType: z.string(),
  model: z.string(),
  generatedAt: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
}).strict();

export interface GenerateImageToolOptions {
  imageClient?: ImageGenerationClient;
  storeFactory?: () => ObjectStorage;
  now?: () => Date;
}

function socialStore(options: GenerateImageToolOptions): BinaryObjectStorage {
  const root = (options.storeFactory ?? createLazyGarageObjectStorage)();
  return asBinaryObjectStorage(createSocialPostStorage(root));
}

/**
 * Fixed safe messages surfaced through the tool result. The agent reads tool
 * errors verbatim and must not claim success when one is returned; none of
 * these expose credentials, endpoints, object keys, or provider diagnostics.
 */
const SAFE_ERRORS = {
  notConfigured: 'Image generation is not configured. Set LLM_IMAGE_MODEL, LLM_BASE_URL, and LLM_API_KEY in agent/.env.',
  notFound: 'Social post not found.',
  notApproved: 'Social post is not approved. Visual generation requires a post whose status is APPROVED.',
  storage: 'Visual asset storage is unavailable. Try again later.',
} as const;

function requireImageModel(): string {
  const model = env.LLM_IMAGE_MODEL.trim();
  if (!model) throw new Error(SAFE_ERRORS.notConfigured);
  return model;
}

export function createGenerateImageTool(options: GenerateImageToolOptions = {}) {
  const client = options.imageClient ?? imageClient;
  const now = options.now ?? (() => new Date());

  const tool = createTool({
    id: 'generate_image',
    description:
      'Generate one image for an APPROVED social post on demand using the fixed image model, store it, and attach it to the post. Use only when the user explicitly asks for a visual; never automatically after content writing.',
    inputSchema,
    outputSchema,
    mcp: {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    execute: async ({ postId, prompt, aspectRatio, imageSize, mimeType }) => {
      const model = requireImageModel();
      const store = socialStore(options);
      await store.ensureReady?.();

      let status: string;
      try {
        const post = await getSocialPost(store, postId);
        status = post.metadata.status;
      } catch (error) {
        if (error instanceof ObjectStorageError && error.code === 'not-found') {
          throw new Error(SAFE_ERRORS.notFound);
        }
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      if (status !== 'APPROVED') {
        throw new Error(SAFE_ERRORS.notApproved);
      }

      let generated;
      try {
        generated = await client.generate(
          { prompt, ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}), ...(mimeType ? { mimeType } : {}) },
        );
      } catch (error) {
        if (isImageGenerationClientError(error)) {
          throw new Error(error.message);
        }
        throw new Error(SAFE_ERRORS.storage);
      }

      const built = buildVisualAsset({
        postId,
        mimeType: generated.mimeType,
        prompt: generated.prompt,
        model: generated.model,
        now,
        ...(generated.width ? { width: generated.width } : {}),
        ...(generated.height ? { height: generated.height } : {}),
      });

      try {
        await store.createBytes(built.objectKey, generated.imageBytes, generated.mimeType);
      } catch (error) {
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      let updated;
      try {
        updated = await attachVisualAsset(store, postId, built.asset);
      } catch (error) {
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      const asset = updated.visualAssets?.find((entry) => entry.assetId === built.asset.assetId) ?? built.asset;
      return {
        postId,
        assetId: asset.assetId,
        objectKey: asset.objectKey,
        imageUrl: asset.imageUrl,
        mimeType: asset.mimeType,
        model: asset.model,
        generatedAt: asset.generatedAt,
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      };
    },
  });

  tool.requireApproval = undefined;
  return tool as typeof tool & {
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
  };
}

export const generateImageTool = createGenerateImageTool();
