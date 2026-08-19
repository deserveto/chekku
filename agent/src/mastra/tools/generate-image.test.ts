import {
  buildSocialPostMetadata,
  createSocialPostStorage,
  ObjectStorageError,
  type BinaryObjectResult,
  type ObjectStorage,
} from '@chekku/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  ImageGenerationClientError,
} from '../../image-generation/errors.js';
import type { ImageGenerationClient, ImageGenerationResult } from '../../image-generation/types.js';
import { createGenerateImageTool } from './generate-image.js';

const postMarkdown = '**Hook:** Hari Guru.\n\nCaption body.';
const briefMarkdown = 'Topic: Hari Guru. Platform: Instagram.';

function createRootStore(): ObjectStorage {
  const text = new Map<string, string>();
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  const root: ObjectStorage = {
    async ensureReady() {},
    async createText(key, value, contentType) {
      if (text.has(key)) throw new Error(`Already exists: ${key}`);
      text.set(key, value);
    },
    async replaceText(key, value, contentType) {
      text.set(key, value);
    },
    async getText(key) {
      const value = text.get(key);
      if (value === undefined) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return value;
    },
    async exists(key) {
      return text.has(key) || bytes.has(key);
    },
    async delete(key) {
      text.delete(key);
      bytes.delete(key);
    },
    async listKeys(prefix) {
      const keys = [...text.keys(), ...bytes.keys()].filter((key) => key.startsWith(prefix));
      return { keys, truncated: false };
    },
    async createBytes(key, value, contentType) {
      if (bytes.has(key)) throw new Error(`Already exists: ${key}`);
      bytes.set(key, { value: new Uint8Array(value), contentType });
    },
    async replaceBytes(key, value, contentType) {
      bytes.set(key, { value: new Uint8Array(value), contentType });
    },
    async getBytes(key): Promise<BinaryObjectResult> {
      const entry = bytes.get(key);
      if (!entry) throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      return { value: new Uint8Array(entry.value), ...(entry.contentType ? { contentType: entry.contentType } : {}) };
    },
  };
  return root;
}

interface SeedOptions {
  status?: 'DRAFT' | 'APPROVED' | 'PUBLISHED';
  postId?: string;
}

function seedPost(root: ObjectStorage, options: SeedOptions = {}) {
  const store = createSocialPostStorage(root);
  const built = buildSocialPostMetadata({
    postMarkdown,
    briefMarkdown,
    topic: 'Hari Guru',
    status: options.status ?? 'APPROVED',
    postId: options.postId ?? 'smp_20260713120000_00000001',
    now: () => new Date('2026-07-13T12:00:00.000Z'),
  });
  return {
    store,
    metadata: built.metadata,
    async write() {
      await store.createText(built.briefObjectKey, briefMarkdown, 'text/markdown');
      await store.createText(built.postObjectKey, postMarkdown, 'text/markdown');
      await store.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
    },
  };
}

function stubClient(result: Partial<ImageGenerationResult> = {}): ImageGenerationClient & {
  calls: ReturnType<typeof vi.fn>;
} {
  // Provide a valid minimal PNG (1x1) so the compositor's `loadImage` does
  // not abort the worker when it receives non-PNG bytes.
  const minimalPng = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  const calls = vi.fn();
  const client: ImageGenerationClient & { calls: typeof calls } = {
    calls,
    async generate(request) {
      calls(request);
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
  return client;
}

const FIXED_NOW = () => new Date('2026-07-28T12:00:00.000Z');

const MODEL = 'gemini-3.1-flash-image';

const TEST_LOGO_PATH = 'agent/src/assets/__test-logo.png';

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
      'premium editorial visualization of a massive AI factory facility, modern architecture, liquid cooling infrastructure, cinematic but realistic, no text, no typography, no logos',
    headline: '170.000 GPU di Batam: Indonesia Sedang Bangun Otot AI',
    facts: ['170.000 AI accelerators', '360 MW planned capacity', 'Q1 2027 initial target'],
    source: 'Sumber: detikInet · 9 Agustus 2026',
    logoPosition: 'bottom-right',
    ...overrides,
  };
}

/**
 * Build the tool with the fixed image model injected, mirroring a configured
 * server. Keeps these tests independent of ambient `env.LLM_IMAGE_MODEL`
 * (which is empty in CI and only set by a local `agent/.env`).
 */
function makeTool(options: Parameters<typeof createGenerateImageTool>[0] = {}) {
  return createGenerateImageTool({ model: MODEL, logoPath: TEST_LOGO_PATH, canvasSize: 512, ...options });
}

interface GenerateImageResult {
  postId: string;
  assetId: string;
  objectKey: string;
  imageUrl: string;
  pillar: string;
  headline: string;
  mimeType: string;
  model: string;
  generatedAt: string;
  width?: number;
  height?: number;
}

async function runTool(
  tool: ReturnType<typeof createGenerateImageTool>,
  input: { postId: string } & Partial<BriefInput>,
): Promise<GenerateImageResult> {
  const merged = { ...makeBrief(), ...input, postId: input.postId } as BriefInput & { postId: string };
  return tool.execute?.(merged, {} as never) as unknown as GenerateImageResult;
}

describe('generate_image tool — identity and schema', () => {
  it('exposes the stable tool id generate_image', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.id).toBe('generate_image');
  });

  it('accepts a postId plus a VisualBrief and rejects unknown fields', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      contentPillar: 'TECHNOLOGY',
      imagePrompt: 'premium editorial visualization, no text',
      headline: '170.000 GPU di Batam',
      facts: ['170.000 AI accelerators', '360 MW planned'],
      source: 'Sumber: detikInet · 9 Agustus 2026',
      logoPosition: 'bottom-right',
      aspectRatio: '1:1',
      imageSize: '1K',
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      ...makeBrief(),
      namespace: 'evil',
      objectKey: 'arbitrary',
      model: 'evil-model',
    }).success).toBe(false);
  });

  it('accepts an optional heroNumber and rejects over-length values', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      ...makeBrief(),
      heroNumber: '360 MW',
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      ...makeBrief(),
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      ...makeBrief(),
      heroNumber: 'x'.repeat(25),
    }).success).toBe(false);
  });

  it('does not let the model choose a model, namespace, or object key', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.shape).not.toHaveProperty('model');
    expect(tool.inputSchema.shape).not.toHaveProperty('namespace');
    expect(tool.inputSchema.shape).not.toHaveProperty('objectKey');
    expect(tool.inputSchema.shape).not.toHaveProperty('endpoint');
  });

  it('uses the fixed image model from the client result, never from input', async () => {
    const client = stubClient({ model: 'gemini-3.1-flash-image' });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = await runTool(tool, { postId: seeded.metadata.postId });

    expect(result.model).toBe('gemini-3.1-flash-image');
  });
});

describe('generate_image tool — configuration', () => {
  it('fails closed with a fixed configuration error when no image model is configured', async () => {
    // No `model` injected and an empty configured model -> the tool must not
    // reach the provider. Deterministic regardless of ambient env.
    const client = stubClient();
    const tool = createGenerateImageTool({ imageClient: client, model: '' });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Image generation is not configured.');
    expect(client.calls).not.toHaveBeenCalled();
  });
});

describe('generate_image tool — approval gate', () => {
  it('succeeds for an APPROVED post and returns the asset metadata', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root, { status: 'APPROVED' });
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = await runTool(tool, { postId: seeded.metadata.postId });

    expect(result.postId).toBe(seeded.metadata.postId);
    expect(result.assetId).toMatch(/^sva_[0-9]{14}_[0-9a-f]{8}$/);
    expect(result.objectKey).toBe(
      `social-posts/${seeded.metadata.postId}/visuals/${result.assetId}.png`,
    );
    expect(result.imageUrl).toBe(
      `/api/storage/social-posts/${seeded.metadata.postId}/visuals/${result.assetId}`,
    );
    expect(result.mimeType).toBe('image/png');
    expect(result.model).toBe('gemini-3.1-flash-image');
    expect(result.generatedAt).toBe('2026-07-28T12:00:00.000Z');
  });

  it('rejects a DRAFT post before any provider call', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root, { status: 'DRAFT' });
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Social post is not approved.');
    expect(client.calls).not.toHaveBeenCalled();
  });

  it('rejects a PUBLISHED post for this iteration', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root, { status: 'PUBLISHED' });
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Social post is not approved.');
  });

  it('rejects an unknown post id with a safe not-found error', async () => {
    const client = stubClient();
    const root = createRootStore();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: 'smp_20260713120000_00000099', ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Social post not found.');
    expect(client.calls).not.toHaveBeenCalled();
  });
});

describe('generate_image tool — ordering and failure handling', () => {
  it('stores image bytes before updating metadata', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = await runTool(tool, { postId: seeded.metadata.postId });

    // The byte object exists at the canonical key.
    const namespaced = createSocialPostStorage(root);
    const bytes = await namespaced.getBytes!(result.objectKey);
    expect(bytes.value.byteLength).toBeGreaterThan(0);

    // Metadata now lists the asset as active.
    const { getSocialPost } = await import('@chekku/storage');
    const post = await getSocialPost(namespaced, seeded.metadata.postId);
    expect(post.metadata.visualAssets?.[0]?.assetId).toBe(result.assetId);
    expect(post.metadata.activeVisualAssetId).toBe(result.assetId);
  });

  it('does not update metadata when image generation fails', async () => {
    const failingClient: ImageGenerationClient = {
      async generate() {
        throw new ImageGenerationClientError('timeout');
      },
    };
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: failingClient,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Image generation timed out.');

    const { getSocialPost } = await import('@chekku/storage');
    const post = await getSocialPost(createSocialPostStorage(root), seeded.metadata.postId);
    expect(post.metadata.visualAssets).toBeUndefined();
    expect(post.metadata.activeVisualAssetId).toBeUndefined();
  });

  it('does not update metadata when the upload fails', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();

    const failingRoot: ObjectStorage = {
      ...root,
      async createBytes() {
        const error = new Error('upload failed');
        Object.assign(error, { code: 'unavailable' });
        throw error;
      },
    };

    const tool = makeTool({
      imageClient: client,
      storeFactory: () => failingRoot,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow();

    const { getSocialPost } = await import('@chekku/storage');
    const post = await getSocialPost(createSocialPostStorage(root), seeded.metadata.postId);
    expect(post.metadata.visualAssets).toBeUndefined();
  });

  it('never leaks provider details through safe errors', async () => {
    const failingClient: ImageGenerationClient = {
      async generate() {
        throw Object.assign(new Error('https://llm.internal token=secret body'), {
          credential: 'private-token',
        });
      },
    };
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: failingClient,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const error: unknown = await tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    ).catch((e: unknown) => e);

    expect(JSON.stringify(error)).not.toMatch(/llm\.internal|private-token|token=secret/);
  });
});

describe('generate_image tool — revisions', () => {
  it('produces a new asset and preserves the previous one', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const first = await runTool(tool, { postId: seeded.metadata.postId });

    const second = await runTool(tool, { postId: seeded.metadata.postId });

    expect(second.assetId).not.toBe(first.assetId);
    expect(second.objectKey).not.toBe(first.objectKey);

    const { getSocialPost } = await import('@chekku/storage');
    const post = await getSocialPost(createSocialPostStorage(root), seeded.metadata.postId);
    const ids = post.metadata.visualAssets?.map((a) => a.assetId) ?? [];
    expect(ids).toEqual([first.assetId, second.assetId]);
    expect(post.metadata.activeVisualAssetId).toBe(second.assetId);
  });
});

describe('generate_image tool — regeneration cap', () => {
  it('exports the MAX_VISUAL_ASSETS_PER_POST constant set to 3', async () => {
    const mod = await import('./generate-image.js');
    expect(mod.MAX_VISUAL_ASSETS_PER_POST).toBe(3);
  });

  it('allows generations while the post has fewer than MAX_VISUAL_ASSETS_PER_POST assets', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    // First two generations must succeed; the cap (3) counts the assets that
    // exist BEFORE the next call, not the call itself.
    const first = await runTool(tool, { postId: seeded.metadata.postId });
    const second = await runTool(tool, { postId: seeded.metadata.postId });
    expect(first.assetId).not.toBe(second.assetId);
  });

  it('refuses the fourth call once the cap of three assets is reached', async () => {
    const client = stubClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await runTool(tool, { postId: seeded.metadata.postId });
    await runTool(tool, { postId: seeded.metadata.postId });
    await runTool(tool, { postId: seeded.metadata.postId });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Visual generation cap reached for this post.');
    expect(client.calls).toHaveBeenCalledTimes(3);
  });

  it('checks the cap after the approval gate so a DRAFT post still reports not-approved first', async () => {
    const client = stubClient();
    const root = createRootStore();
    // Seed a DRAFT post and pre-attach three assets directly so the cap is
    // already at maximum. The approval gate must run before the cap check.
    const { attachVisualAsset, buildVisualAsset } = await import('@chekku/storage');
    const seeded = seedPost(root, { status: 'DRAFT' });
    await seeded.write();
    const namespaced = createSocialPostStorage(root);
    for (let i = 0; i < 3; i++) {
      const built = buildVisualAsset({
        postId: seeded.metadata.postId,
        mimeType: 'image/png',
        prompt: `seed ${i}`,
        model: 'gemini-3.1-flash-image',
        now: () => new Date(`2026-07-2${i}T12:00:00.000Z`),
      });
      const binary = namespaced as unknown as {
        createBytes(key: string, value: Uint8Array, contentType?: string): Promise<void>;
      };
      await binary.createBytes(built.objectKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), built.asset.mimeType);
      await attachVisualAsset(namespaced, seeded.metadata.postId, built.asset);
    }

    const tool = makeTool({
      imageClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, ...makeBrief() } as never,
      {} as never,
    )).rejects.toThrow('Social post is not approved.');
    expect(client.calls).not.toHaveBeenCalled();
  });
});
