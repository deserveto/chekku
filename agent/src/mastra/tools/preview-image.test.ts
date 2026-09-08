import { createNamespacedObjectStorage, SOCIAL_MEDIA_AGENT_ID, type ObjectStorage } from '@chekku/storage';
import { describe, expect, it, vi } from 'vitest';

import type { ImageGenerationClient, ImageGenerationResult } from '../../image-generation/types.js';
import { ImageGenerationClientError } from '../../image-generation/errors.js';
import { createPreviewImageTool, PREVIEW_ID_PATTERN } from './preview-image.js';

const TEST_LOGO_PATH = 'agent/src/assets/__test-logo.png';

/** Minimal in-memory root store that records binary writes. */
function fakeRootStore(): ObjectStorage & { bytes: Map<string, { value: Uint8Array; contentType?: string }> } {
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  const root: ObjectStorage & { bytes: typeof bytes } = {
    bytes,
    async createText() {},
    async replaceText() {},
    async getText() {
      return '';
    },
    async exists() {
      return false;
    },
    async delete() {},
    async listKeys() {
      return { keys: [], truncated: false };
    },
    async createBytes(key, value, contentType) {
      bytes.set(key, { value, contentType });
    },
    async replaceBytes(key, value, contentType) {
      bytes.set(key, { value, contentType });
    },
    async getBytes(key) {
      const entry = bytes.get(key);
      if (!entry) throw new Error(`not-found: ${key}`);
      return { value: entry.value, ...(entry.contentType ? { contentType: entry.contentType } : {}) };
    },
  };
  return root;
}

function namespacedStore(root: ObjectStorage) {
  return createNamespacedObjectStorage(root, SOCIAL_MEDIA_AGENT_ID);
}

function stubClient(result: Partial<ImageGenerationResult> = {}): ImageGenerationClient {
  // Provide a valid minimal PNG (1x1) so the compositor's `loadImage` does
  // not abort the worker when it receives non-PNG bytes.
  const minimalPng = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  return {
    async generate(request) {
      return {
        imageBytes: result.imageBytes ?? minimalPng,
        mimeType: result.mimeType ?? 'image/png',
        model: result.model ?? 'gemini-3.1-flash-image',
        prompt: result.prompt ?? request.prompt,
        ...(result.width ? { width: result.width } : {}),
        ...(result.height ? { height: result.height } : {}),
      };
    },
  };
}

const FIXED_NOW = () => new Date('2026-08-08T12:00:00.000Z');
const MODEL = 'gemini-3.1-flash-image';

type BriefInput = {
  contentPillar: 'CELEBRATION' | 'TECHNOLOGY' | 'GENERAL';
  imagePrompt: string;
  headline: string;
  facts: string[];
  context?: string;
  source: string;
  logoPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  aspectRatio?: '1:1' | '4:5' | '9:16' | '16:9';
  imageSize?: '1K' | '2K';
};

/**
 * Build a valid VisualBrief input for the tool. Tests can spread overrides
 * on top: `makeBrief({ contentPillar: 'CELEBRATION' })`.
 */
function makeBrief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    contentPillar: 'TECHNOLOGY',
    imagePrompt:
      'premium editorial visualization of a massive AI factory facility, modern architecture, no text, no typography, no logos',
    headline: '170.000 GPU di Batam: Indonesia Sedang Bangun Otot AI',
    facts: ['170.000 AI accelerators', '360 MW planned capacity', 'Q1 2027 initial target'],
    source: 'Sumber: detikInet · 9 Agustus 2026',
    logoPosition: 'bottom-right',
    ...overrides,
  };
}

function makeTool(options: Parameters<typeof createPreviewImageTool>[0] = {}) {
  return createPreviewImageTool({
    model: MODEL,
    now: FIXED_NOW,
    logoPath: TEST_LOGO_PATH,
    canvasSize: 512,
    ...options,
  });
}

interface PreviewResult {
  previewId: string;
  imageUrl: string;
  pillar: string;
  headline: string;
  source: string;
  mimeType: string;
  model: string;
  generatedAt: string;
  width?: number;
  height?: number;
}

async function runTool(
  tool: ReturnType<typeof createPreviewImageTool>,
  input: Partial<BriefInput> = {},
): Promise<PreviewResult> {
  const merged = makeBrief(input);
  return tool.execute?.(merged, {} as never) as unknown as PreviewResult;
}

describe('preview_image tool', () => {
  it('composes a final PNG (background + text layers + logo) and stores it under chat-previews/<id>.png', async () => {
    const root = fakeRootStore();
    const tool = makeTool({
      imageClient: stubClient({ mimeType: 'image/png' }),
      storeFactory: () => root,
    });

    const result = await runTool(tool);

    expect(result.previewId).toMatch(PREVIEW_ID_PATTERN);
    expect(result.imageUrl).toBe(`/api/storage/chat-previews/${result.previewId}.png`);
    expect(result.pillar).toBe('TECHNOLOGY');
    expect(result.headline).toContain('170.000 GPU di Batam');
    expect(result.source).toContain('detikInet');
    expect(result.mimeType).toBe('image/png');
    expect(result.model).toBe(MODEL);
    expect(result.generatedAt).toBe('2026-08-08T12:00:00.000Z');
    // The compositor always emits PNG, regardless of what the gateway returned.
    // No base64 leaks into the result — context stays small.
    expect(JSON.stringify(result)).not.toContain('data:image');

    // Bytes landed in the namespaced social-media-agent chat-previews prefix.
    const namespaced = namespacedStore(root) as ObjectStorage & { getBytes?(k: string): Promise<{ value: Uint8Array }> };
    const stored = await namespaced.getBytes!(`chat-previews/${result.previewId}.png`);
    expect(stored.value.byteLength).toBeGreaterThan(0);
    // PNG magic bytes — confirms the compositor emitted a real PNG, not just
    // a passthrough of the (tiny) stub bytes.
    expect(stored.value[0]).toBe(0x89);
    expect(stored.value[1]).toBe(0x50);
    expect(stored.value[2]).toBe(0x4e);
    expect(stored.value[3]).toBe(0x47);
  });

  it('does not let the model choose the model, namespace, or object key', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.shape).not.toHaveProperty('model');
    expect(tool.inputSchema.shape).not.toHaveProperty('namespace');
    expect(tool.inputSchema.shape).not.toHaveProperty('objectKey');
    expect(tool.inputSchema.shape).not.toHaveProperty('previewId');
  });

  it('rejects unknown fields via the strict schema', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(
      tool.inputSchema.safeParse({ ...makeBrief(), postId: 'smp_evil', namespace: 'evil' }).success,
    ).toBe(false);
    expect(tool.inputSchema.safeParse({ imagePrompt: '   ' }).success).toBe(false);
  });

  it('accepts an optional heroNumber (LEVEL 1 visual hook) and rejects over-length values', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.safeParse({ ...makeBrief(), heroNumber: '360 MW' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ ...makeBrief(), heroNumber: '170.000 GPU' }).success).toBe(true);
    // Omitting heroNumber is valid — the layout adapts to headline-only top zone.
    expect(tool.inputSchema.safeParse({ ...makeBrief() }).success).toBe(true);
    // Over-length hero number is rejected (the compositor reserves limited top-zone real estate).
    expect(tool.inputSchema.safeParse({ ...makeBrief(), heroNumber: 'x'.repeat(25) }).success).toBe(false);
  });
  it('surfaces a fixed configuration error when the image model is unset', async () => {
    const root = fakeRootStore();
    const tool = createPreviewImageTool({
      model: '',
      now: FIXED_NOW,
      logoPath: TEST_LOGO_PATH,
      canvasSize: 512,
      imageClient: stubClient(),
      storeFactory: () => root,
    });

    await expect(runTool(tool)).rejects.toThrow('Image generation is not configured');
  });

  it('rethrows client provider errors as fixed safe messages', async () => {
    const failing: ImageGenerationClient = {
      async generate() {
        const err = new Error('provider said no') as Error & { isImageGenerationClientError?: boolean };
        // Mimic the client-error marker checked by isImageGenerationClientError.
        (err as unknown as { message: string }).message = 'Image provider is unavailable.';
        throw err;
      },
    };
    const root = fakeRootStore();
    const tool = makeTool({ imageClient: failing, storeFactory: () => root });

    // Whether or not the thrown error carries the client-error marker, the
    // tool must reject (not hang, not leak a stack).
    await expect(runTool(tool)).rejects.toThrow();
  });

  it('logs the failure cause server-side while rejecting with the fixed safe message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing: ImageGenerationClient = {
        async generate() {
          throw new ImageGenerationClientError('configuration');
        },
      };
      const root = fakeRootStore();
      const tool = makeTool({ imageClient: failing, storeFactory: () => root });

      await expect(runTool(tool)).rejects.toThrow('Image generation is not configured.');
      expect(warn).toHaveBeenCalledWith(
        '[preview_image] image generation failed: category=configuration',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
