import {
  asBinaryObjectStorage,
  createLazyGarageObjectStorage,
  createNamespacedObjectStorage,
  ObjectStorageError,
  SOCIAL_MEDIA_AGENT_ID,
  type BinaryObjectStorage,
  type ObjectStorage,
} from '@chekku/storage';
import { randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { composeVisual, loadBrandLogoBytes } from '../../image-generation/compositor.js';
import { isImageGenerationClientError } from '../../image-generation/errors.js';
import { imageClient } from '../../image-generation/client.js';
import {
  FACTS_SCHEMA,
  HEADLINE_SCHEMA,
  HERO_NUMBER_SCHEMA,
  IMAGE_PROMPT_SCHEMA,
  LOGO_POSITION_SCHEMA,
  SOURCE_SCHEMA,
  CONTENT_PILLAR_SCHEMA,
  type ImageGenerationClient,
  type ImageGenerationResult,
  type ImageMimeType,
} from '../../image-generation/index.js';

/**
 * Visual Content Agent — `preview_image` tool (dev-only).
 *
 * ARCHITECTURE (Rafiqspace visual pipeline upgrade):
 *
 *   brief (VisualBrief) ───► imageClient.generate(imagePrompt)
 *                                  │
 *                                  ▼
 *                            background PNG bytes
 *                                  │
 *                                  ▼
 *                          composeVisual({brief, bg, logo})
 *                                  │
 *                                  ▼
 *                            final PNG bytes
 *                                  │
 *                                  ▼
 *                            Garage storage
 *
 * The image-generation gateway is text-to-image ONLY and unreliable at
 * rendering legible typography or the brand logo. This tool enforces the
 * split:
 *   - `imagePrompt` describes SUBJECT / ENVIRONMENT / LIGHTING / COMPOSITION
 *     / MATERIAL / CAMERA / MOOD — pure visual, NO text requests.
 *   - `headline` / `facts` / `context` / `source` are rendered by the
 *     application-layer compositor (`agent/src/image-generation/compositor.ts`).
 *   - The Rafiqspace logo is loaded from `agent/src/assets/image.png` and
 *     stamped onto the final image as-is. NEVER regenerated, NEVER drawn by
 *     the image model, NEVER replaced with wordmark text.
 *
 * Dev-only: no postId, no approval check, isolated `chat-previews/` prefix.
 * Production uses the post-bound `generate_image` tool which shares the same
 * pipeline but verifies APPROVED status before composing.
 */

const PREVIEW_PREFIX = 'chat-previews';
const PREVIEW_ID_RE = /^prev_[0-9]{14}_[0-9a-f]{8}$/;

const inputSchema = z
  .object({
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
    previewId: z.string(),
    imageUrl: z.string(),
    pillar: z.string(),
    headline: z.string(),
    source: z.string(),
    mimeType: z.string(),
    model: z.string(),
    generatedAt: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .strict();

const SAFE_ERRORS = {
  notConfigured: 'Image generation is not configured. Set LLM_IMAGE_MODEL, LLM_BASE_URL, and LLM_API_KEY in agent/.env.',
  invalidBrief: 'Visual brief is invalid. Supply contentPillar, imagePrompt, headline, facts, and source.',
  storage: 'Preview storage is unavailable. Try again later.',
  composition: 'Visual composition failed. The brief or brand asset could not be rendered.',
} as const;

function requireImageModel(explicit?: string): string {
  const model = (explicit ?? env.LLM_IMAGE_MODEL).trim();
  if (!model) throw new Error(SAFE_ERRORS.notConfigured);
  return model;
}

function createPreviewId(now: Date): string {
  const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const hex = randomUUID().replace(/-/g, '').slice(0, 8);
  return `prev_${ts}_${hex}`;
}

function canvasSizeFor(imageSize: '1K' | '2K' | undefined): number {
  return imageSize === '2K' ? 2048 : 1024;
}

export interface PreviewImageToolOptions {
  imageClient?: ImageGenerationClient;
  storeFactory?: () => ObjectStorage;
  /**
   * Server-owned image model id. Defaults to `env.LLM_IMAGE_MODEL`; exposed
   * as a constructor seam so tests do not depend on ambient env. Never read
   * from tool/model input.
   */
  model?: string;
  /**
   * Override path to the brand logo PNG. Production reads
   * `agent/src/assets/image.png` via the compositor's brand-asset resolver.
   */
  logoPath?: string;
  /**
   * Override the compositing canvas size (default 1024). Exposed for tests
   * that want a faster smaller render.
   */
  canvasSize?: number;
  now?: () => Date;
}

function previewStore(options: PreviewImageToolOptions): BinaryObjectStorage {
  const root = (options.storeFactory ?? createLazyGarageObjectStorage)();
  return asBinaryObjectStorage(createNamespacedObjectStorage(root, SOCIAL_MEDIA_AGENT_ID));
}

/** Route prefix mirrored by the client `GET /api/storage/chat-previews/[file]` route. */
export const CHAT_PREVIEW_URL_PREFIX = '/api/storage/chat-previews';

/** Regex shared with the client route so both sides agree on the id shape. */
export const PREVIEW_ID_PATTERN = PREVIEW_ID_RE;

export function createPreviewImageTool(options: PreviewImageToolOptions = {}) {
  const client = options.imageClient ?? imageClient;
  const now = options.now ?? (() => new Date());
  const canvasSize = options.canvasSize ?? 1024;

  const tool = createTool({
    id: 'preview_image',
    description:
      'Compose one standalone preview image for an ad-hoc chat visual. Takes a structured VisualBrief (contentPillar, pure-visual imagePrompt, headline, 2-3 verified facts, optional editorial context, source attribution). The image model renders ONLY the background visual; the application compositor overlays the headline, facts, source, and the real Rafiqspace logo from agent/src/assets. Use for an ad-hoc visual requested directly in chat with no postId. Never use when the user references an APPROVED postId — use generate_image for that.',
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
        if (isImageGenerationClientError(error)) {
          throw new Error(error.message);
        }
        throw new Error(SAFE_ERRORS.storage);
      }

      let logoBytes: Uint8Array;
      try {
        logoBytes = loadBrandLogoBytes(options.logoPath);
      } catch {
        throw new Error(SAFE_ERRORS.composition);
      }

      const brief = {
        contentPillar,
        imagePrompt: generatedPrompt,
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
          canvasSize: imageSize === '2K' ? 2048 : canvasSize,
        });
      } catch {
        throw new Error(SAFE_ERRORS.composition);
      }

      const store = previewStore(options);
      await store.ensureReady?.();
      const previewId = createPreviewId(now());
      const ext = 'png';
      const objectKey = `${PREVIEW_PREFIX}/${previewId}.${ext}`;

      try {
        await store.createBytes(objectKey, composed, 'image/png');
      } catch (error) {
        if (error instanceof ObjectStorageError) {
          throw new Error(SAFE_ERRORS.storage);
        }
        throw error;
      }

      const finalMime: ImageMimeType = 'image/png';

      return {
        previewId,
        imageUrl: `${CHAT_PREVIEW_URL_PREFIX}/${previewId}.${ext}`,
        pillar: contentPillar,
        headline: brief.headline,
        source: brief.source,
        mimeType: finalMime,
        model: generated.model,
        generatedAt: now().toISOString(),
        width: imageSize === '2K' ? 2048 : canvasSizeFor(imageSize),
        height: imageSize === '2K' ? 2048 : canvasSizeFor(imageSize),
      };
    },
  });

  tool.requireApproval = undefined;
  return tool as typeof tool & {
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
  };
}

export const previewImageTool = createPreviewImageTool();
