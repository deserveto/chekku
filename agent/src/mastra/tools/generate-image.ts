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

import { composeVisual, loadBrandLogoBytes } from '../../image-generation/compositor.js';
import {
  describeImageGenerationFailure,
  isImageGenerationClientError,
} from '../../image-generation/errors.js';
import { imageClient } from '../../image-generation/client.js';
import {
  CONTENT_PILLAR_SCHEMA,
  FACTS_SCHEMA,
  HEADLINE_SCHEMA,
  HERO_NUMBER_SCHEMA,
  IMAGE_PROMPT_SCHEMA,
  LOGO_POSITION_SCHEMA,
  SOURCE_SCHEMA,
  type ImageGenerationClient,
  type ImageGenerationResult,
  type ImageMimeType,
} from '../../image-generation/index.js';
import { env } from '../../config/env.js';

/**
 * Visual Content Agent — `generate_image` tool.
 *
 * ARCHITECTURE (Rafiqspace visual pipeline upgrade): same split as
 * `preview_image` — the image-generation gateway contributes ONLY the
 * background visual; the application compositor overlays headline, facts,
 * source, and the real Rafiqspace logo. Generates one composited image for
 * an APPROVED social post on demand, stores the final PNG bytes in Garage
 * under the historical `social-media-agent` namespace, and attaches the
 * resulting asset to the post's canonical metadata. The metadata write is
 * the last step, so a generation or upload failure never produces a
 * canonical entry that points at missing bytes.
 *
 * Security invariants (unchanged):
 * - The model id is fixed by `LLM_IMAGE_MODEL` and never comes from input.
 * - The namespace is fixed to `social-media-agent`; the model cannot choose it.
 * - The asset id and object key are generated server-side.
 * - Approval status is read from persisted metadata.
 * - Provider and storage failures are normalized to fixed safe errors.
 */

const POST_ID_SCHEMA = z.string().regex(/^smp_[0-9]{14}_[0-9a-f]{8}$/);

const inputSchema = z
  .object({
    postId: POST_ID_SCHEMA,
    contentPillar: CONTENT_PILLAR_SCHEMA,
    imagePrompt: IMAGE_PROMPT_SCHEMA,
    heroNumber: HERO_NUMBER_SCHEMA,
    date: z.string().optional(),
    headline: HEADLINE_SCHEMA,
    facts: FACTS_SCHEMA,
    context: z
      .string()
      .refine(
        (value) => value.trim().length > 0 && value.length <= 140,
        'context must be a non-empty string of at most 140 characters.',
      )
      .optional(),
    source: SOURCE_SCHEMA.default(''),
    logoPosition: LOGO_POSITION_SCHEMA.default('bottom-right'),
    aspectRatio: z.enum(['1:1', '4:5', '9:16', '16:9']).optional(),
    imageSize: z.enum(['1K', '2K']).optional(),
    visualIdentity: z.string().optional(),
    artDirection: z.string().optional(),
    heroSubject: z.string().optional(),
    composition: z.string().optional(),
    lighting: z.string().optional(),
    cameraDirection: z.string().optional(),
    typographyStyle: z.string().optional(),
    informationHierarchy: z.string().optional(),
    decorativeElements: z.string().optional(),
    forbiddenElements: z.string().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    postId: z.string(),
    assetId: z.string(),
    objectKey: z.string(),
    imageUrl: z.string(),
    pillar: z.string(),
    headline: z.string(),
    mimeType: z.string(),
    model: z.string(),
    generatedAt: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .strict();

export interface GenerateImageToolOptions {
  imageClient?: ImageGenerationClient;
  storeFactory?: () => ObjectStorage;
  /**
   * Server-owned image model id. Defaults to `env.LLM_IMAGE_MODEL`; exposed as
   * a constructor seam (like `imageClient`/`storeFactory`) so tests do not
   * depend on ambient env. It is never read from tool/model input.
   */
  model?: string;
  /**
   * Override path to the brand logo PNG. Production reads
   * `agent/src/assets/image.png` via the compositor's brand-asset resolver.
   */
  logoPath?: string;
  /**
   * Override the compositing canvas size (default 1024). Exposed for tests.
   */
  canvasSize?: number;
  now?: () => Date;
}

function socialStore(options: GenerateImageToolOptions): BinaryObjectStorage {
  const root = (options.storeFactory ?? createLazyGarageObjectStorage)();
  return asBinaryObjectStorage(createSocialPostStorage(root));
}

/**
 * Hard cap on the number of visual assets a single post may accumulate. Each
 * regeneration produces a new asset (revisions never edit), so this caps the
 * self-review loop at MAX_VISUAL_ASSETS_PER_POST attempts: one initial
 * generation plus (MAX_VISUAL_ASSETS_PER_POST - 1) regeneration retries after
 * the reviewer returns `fail`. Once the cap is reached, the tool refuses
 * further generations with `SAFE_ERRORS.maxRegenerationsReached` so the agent
 * returns the latest image instead of looping forever.
 */
export const MAX_VISUAL_ASSETS_PER_POST = 3;

/**
 * Fixed safe messages surfaced through the tool result. The agent reads tool
 * errors verbatim and must not claim success when one is returned; none of
 * these expose credentials, endpoints, object keys, or provider diagnostics.
 */
const SAFE_ERRORS = {
  notConfigured: 'Image generation is not configured. Set LLM_IMAGE_MODEL, LLM_BASE_URL, and LLM_API_KEY in agent/.env.',
  notFound: 'Social post not found.',
  notApproved: 'Social post is not approved. Visual generation requires a post whose status is APPROVED.',
  maxRegenerationsReached: 'Visual generation cap reached for this post. Stop regenerating and return the latest image with a note that further retries are not allowed.',
  storage: 'Visual asset storage is unavailable. Try again later.',
  composition: 'Visual composition failed. The brief or brand asset could not be rendered.',
} as const;

function requireImageModel(explicit?: string): string {
  const model = (explicit ?? env.LLM_IMAGE_MODEL).trim();
  if (!model) throw new Error(SAFE_ERRORS.notConfigured);
  return model;
}

function canvasSizeFor(imageSize: '1K' | '2K' | undefined, fallback: number): number {
  return imageSize === '2K' ? 2048 : fallback;
}

export function createGenerateImageTool(options: GenerateImageToolOptions = {}) {
  const client = options.imageClient ?? imageClient;
  const now = options.now ?? (() => new Date());
  const canvasSize = options.canvasSize ?? 1024;

  const tool = createTool({
    id: 'generate_image',
    description:
      'Compose one visual asset for an APPROVED social post. Takes a postId plus a structured VisualBrief (contentPillar, pure-visual imagePrompt, headline, 2-3 verified facts, optional context, source, logoPosition). The image model renders ONLY the background visual; the application compositor overlays the headline, facts, source, and the real Rafiqspace logo from agent/src/assets. Use only when the user explicitly asks for a visual; never automatically after content writing.',
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
    execute: async (raw) => {
      requireImageModel(options.model);
      const store = socialStore(options);
      await store.ensureReady?.();

      const { postId } = raw;

      let status: string;
      let existingAssetCount: number;
      try {
        const post = await getSocialPost(store, postId);
        status = post.metadata.status;
        existingAssetCount = post.metadata.visualAssets?.length ?? 0;
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

      if (existingAssetCount >= MAX_VISUAL_ASSETS_PER_POST) {
        throw new Error(SAFE_ERRORS.maxRegenerationsReached);
      }

      const {
        contentPillar,
        aspectRatio,
        imageSize,
        visualIdentity,
        artDirection,
        heroSubject,
        composition,
        lighting,
        cameraDirection,
        typographyStyle,
        informationHierarchy,
        decorativeElements,
        forbiddenElements,
        imagePrompt,
      } = raw;

      const generatedPrompt = [
        visualIdentity ? `VISUAL IDENTITY: ${visualIdentity}` : '',
        artDirection ? `ART DIRECTION: ${artDirection}` : '',
        heroSubject ? `HERO SUBJECT: ${heroSubject}` : '',
        composition ? `COMPOSITION: ${composition}` : '',
        lighting ? `LIGHTING: ${lighting}` : '',
        cameraDirection ? `CAMERA: ${cameraDirection}` : '',
        typographyStyle ? `TYPOGRAPHY STYLE: ${typographyStyle}` : '',
        informationHierarchy ? `INFORMATION HIERARCHY: ${informationHierarchy}` : '',
        decorativeElements ? `DECORATIVE ELEMENTS: ${decorativeElements}` : '',
        forbiddenElements ? `NEGATIVE: ${forbiddenElements}` : '',
        imagePrompt ? `ADDITIONAL: ${imagePrompt}` : '',
      ].filter(Boolean).join('\n');

      let generated: ImageGenerationResult;
      try {
        generated = await client.generate({
          prompt: generatedPrompt,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(imageSize ? { imageSize } : {}),
        });
      } catch (error) {
        console.warn(
          `[generate_image] image generation failed: ${describeImageGenerationFailure(error)}`,
        );
        if (isImageGenerationClientError(error)) {
          throw new Error(error.message);
        }
        throw new Error(SAFE_ERRORS.storage);
      }

      let logoBytes: Uint8Array;
      try {
        logoBytes = loadBrandLogoBytes(options.logoPath);
      } catch (error) {
        console.warn(
          `[generate_image] brand logo load failed: ${describeImageGenerationFailure(error)}`,
        );
        throw new Error(SAFE_ERRORS.composition);
      }

      const brief = {
        contentPillar,
        imagePrompt,
        ...(raw.heroNumber ? { heroNumber: raw.heroNumber } : {}),
        ...(raw.date ? { date: raw.date } : {}),
        headline: raw.headline,
        facts: raw.facts,
        ...(raw.context ? { context: raw.context } : {}),
        source: raw.source ?? '',
        logoPosition: raw.logoPosition,
      };

      let composed: Uint8Array;
      try {
        composed = await composeVisual({
          brief,
          backgroundBytes: generated.imageBytes,
          logoBytes,
          canvasSize: canvasSizeFor(imageSize, canvasSize),
        });
      } catch (error) {
        console.warn(
          `[generate_image] composition failed: ${describeImageGenerationFailure(error)}`,
        );
        throw new Error(SAFE_ERRORS.composition);
      }

      const finalMime: ImageMimeType = 'image/png';
      const finalDimensions = canvasSizeFor(imageSize, canvasSize);

      const built = buildVisualAsset({
        postId,
        mimeType: finalMime,
        prompt: generatedPrompt,
        model: generated.model,
        now,
        width: finalDimensions,
        height: finalDimensions,
      });

      try {
        await store.createBytes(built.objectKey, composed, finalMime);
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
        pillar: contentPillar,
        headline: brief.headline,
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
