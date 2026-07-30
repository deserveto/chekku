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
  const calls = vi.fn();
  const client: ImageGenerationClient & { calls: typeof calls } = {
    calls,
    async generate(request) {
      calls(request);
      return {
        imageBytes: result.imageBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
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

/**
 * Build the tool with the fixed image model injected, mirroring a configured
 * server. Keeps these tests independent of ambient `env.LLM_IMAGE_MODEL`
 * (which is empty in CI and only set by a local `agent/.env`).
 */
function makeTool(options: Parameters<typeof createGenerateImageTool>[0] = {}) {
  return createGenerateImageTool({ model: MODEL, ...options });
}

interface GenerateImageResult {
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

async function runTool(
  tool: ReturnType<typeof createGenerateImageTool>,
  input: { postId: string; prompt: string; aspectRatio?: '1:1' | '4:5' | '9:16' | '16:9'; imageSize?: '1K' | '2K'; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp' },
): Promise<GenerateImageResult> {
  return tool.execute?.(input, {} as never) as unknown as GenerateImageResult;
}

describe('generate_image tool — identity and schema', () => {
  it('exposes the stable tool id generate_image', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.id).toBe('generate_image');
  });

  it('accepts postId, prompt, and bounded options and rejects unknown fields', () => {
    const tool = makeTool({ imageClient: stubClient() });
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      prompt: 'warm light',
      aspectRatio: '1:1',
      imageSize: '1K',
      mimeType: 'image/png',
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      prompt: 'warm light',
      namespace: 'evil',
      objectKey: 'arbitrary',
      model: 'evil-model',
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

    const result = await runTool(tool, { postId: seeded.metadata.postId, prompt: 'soft morning light' });

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
      { postId: seeded.metadata.postId, prompt: 'x' },
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

    const result = await runTool(tool, { postId: seeded.metadata.postId, prompt: 'warm sunlight on a desk' });

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
      { postId: seeded.metadata.postId, prompt: 'x' },
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
      { postId: seeded.metadata.postId, prompt: 'x' },
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
      { postId: 'smp_20260713120000_00000099', prompt: 'x' },
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

    const result = await runTool(tool, { postId: seeded.metadata.postId, prompt: 'first image' });

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
      { postId: seeded.metadata.postId, prompt: 'x' },
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
      { postId: seeded.metadata.postId, prompt: 'x' },
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
      { postId: seeded.metadata.postId, prompt: 'x' },
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

    const first = await runTool(tool, { postId: seeded.metadata.postId, prompt: 'first attempt' });

    const second = await runTool(tool, { postId: seeded.metadata.postId, prompt: 'revision' });

    expect(second.assetId).not.toBe(first.assetId);
    expect(second.objectKey).not.toBe(first.objectKey);

    const { getSocialPost } = await import('@chekku/storage');
    const post = await getSocialPost(createSocialPostStorage(root), seeded.metadata.postId);
    const ids = post.metadata.visualAssets?.map((a) => a.assetId) ?? [];
    expect(ids).toEqual([first.assetId, second.assetId]);
    expect(post.metadata.activeVisualAssetId).toBe(second.assetId);
  });
});
