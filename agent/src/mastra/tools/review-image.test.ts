import {
  attachVisualAsset,
  buildSocialPostMetadata,
  buildVisualAsset,
  createSocialPostStorage,
  ObjectStorageError,
  type BinaryObjectResult,
  type ObjectStorage,
} from '@chekku/storage';
import { describe, expect, it, vi } from 'vitest';

import { ImageGenerationClientError } from '../../image-generation/errors.js';
import type {
  ImageReviewClient,
  ImageReviewResult,
} from '../../image-generation/types.js';
import { createReviewImageTool } from './review-image.js';

const postMarkdown = '**Hook:** Hari Guru.';
const briefMarkdown = 'Topic: Hari Guru. Platform: Instagram.';
const POST_ID = 'smp_20260713120000_00000001';

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
  withAsset?: boolean;
}

function seedPost(root: ObjectStorage, options: SeedOptions = {}) {
  const store = createSocialPostStorage(root);
  const built = buildSocialPostMetadata({
    postMarkdown,
    briefMarkdown,
    topic: 'Hari Guru',
    status: options.status ?? 'APPROVED',
    postId: options.postId ?? POST_ID,
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

async function attachOneAsset(root: ObjectStorage, postId: string): Promise<{ assetId: string }> {
  const store = createSocialPostStorage(root);
  const asset = buildVisualAsset({
    postId,
    mimeType: 'image/png',
    prompt: 'poster for hari guru',
    model: 'gemini-3.1-flash-image',
    now: () => new Date('2026-07-28T12:00:00.000Z'),
  });
  const binary = store as unknown as {
    createBytes(key: string, value: Uint8Array, contentType?: string): Promise<void>;
  };
  await binary.createBytes(asset.objectKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), asset.asset.mimeType);
  await attachVisualAsset(store, postId, asset.asset);
  return { assetId: asset.asset.assetId };
}

function stubReviewClient(result: Partial<ImageReviewResult> = {}): ImageReviewClient & {
  calls: ReturnType<typeof vi.fn>;
} {
  const calls = vi.fn();
  const client: ImageReviewClient & { calls: typeof calls } = {
    calls,
    async review(request) {
      calls(request);
      return {
        score: result.score ?? 100,
        issues: result.issues ?? [],
        suggestion: result.suggestion ?? '',
        model: result.model ?? 'gemini-3.1-flash-image',
      };
    },
  };
  return client;
}

const FIXED_NOW = () => new Date('2026-07-28T12:00:00.000Z');
const MODEL = 'gemini-3.1-flash-image';

function makeTool(options: Parameters<typeof createReviewImageTool>[0] = {}) {
  return createReviewImageTool({ model: MODEL, ...options });
}

interface ReviewImageResult {
  postId: string;
  assetId: string;
  score: number;
  issues: string[];
  suggestion: string;
  model: string;
  reviewedAt: string;
}

async function runTool(
  tool: ReturnType<typeof createReviewImageTool>,
  input: { postId: string; assetId: string; brief: string },
): Promise<ReviewImageResult> {
  return tool.execute?.(input, {} as never) as unknown as ReviewImageResult;
}

describe('review_image tool — identity and schema', () => {
  it('exposes the stable tool id review_image', () => {
    const tool = makeTool({ reviewClient: stubReviewClient() });
    expect(tool.id).toBe('review_image');
  });

  it('accepts postId, assetId, and brief; rejects unknown fields', () => {
    const tool = makeTool({ reviewClient: stubReviewClient() });
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      assetId: 'sva_20260728120000_00000001',
      brief: 'canonical brief',
    }).success).toBe(true);
    expect(tool.inputSchema.safeParse({
      postId: 'smp_20260713120000_00000001',
      assetId: 'sva_20260728120000_00000001',
      brief: 'brief',
      model: 'evil',
      namespace: 'evil',
    }).success).toBe(false);
  });

  it('is annotated read-only, non-destructive, idempotent, open-world', () => {
    const tool = makeTool({ reviewClient: stubReviewClient() });
    expect(tool.mcp?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe('review_image tool — happy path', () => {
  it('returns a passing score with the fixed model and timestamp', async () => {
    const client = stubReviewClient({ score: 100 });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = await runTool(tool, {
      postId: seeded.metadata.postId,
      assetId,
      brief: 'poster for hari guru with 3 panels',
    });

    expect(result.postId).toBe(seeded.metadata.postId);
    expect(result.assetId).toBe(assetId);
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
    expect(result.suggestion).toBe('');
    expect(result.model).toBe('gemini-3.1-flash-image');
    expect(result.reviewedAt).toBe('2026-07-28T12:00:00.000Z');
  });

  it('returns a failing score with issues and suggestion', async () => {
    const client = stubReviewClient({
      score: 50,
      issues: ['headline typo'],
      suggestion: 'fix the spelling of "Guru"',
    });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = await runTool(tool, {
      postId: seeded.metadata.postId,
      assetId,
      brief: 'poster for hari guru',
    });

    expect(result.score).toBe(50);
    expect(result.issues).toEqual(['headline typo']);
    expect(result.suggestion).toBe('fix the spelling of "Guru"');
  });

  it('forwards the asset bytes and brief to the review client unchanged', async () => {
    const client = stubReviewClient({ score: 100 });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await runTool(tool, {
      postId: seeded.metadata.postId,
      assetId,
      brief: 'canonical brief text',
    });

    expect(client.calls).toHaveBeenCalledOnce();
    const call = client.calls.mock.calls[0]![0] as {
      imageBytes: Uint8Array;
      mimeType: string;
      brief: string;
    };
    expect(call.brief).toBe('canonical brief text');
    expect(call.mimeType).toBe('image/png');
    expect(call.imageBytes[0]).toBe(0x89);
    expect(call.imageBytes[1]).toBe(0x50);
    expect(call.imageBytes[2]).toBe(0x4e);
    expect(call.imageBytes[3]).toBe(0x47);
  });
});

describe('review_image tool — configuration', () => {
  it('fails closed with a fixed configuration error when no image model is configured', async () => {
    const client = stubReviewClient();
    const tool = createReviewImageTool({ reviewClient: client, model: '' });
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, assetId, brief: 'brief' },
      {} as never,
    )).rejects.toThrow('Image review is not configured.');
    expect(client.calls).not.toHaveBeenCalled();
  });
});

describe('review_image tool — asset verification', () => {
  it('rejects a postId that does not exist with the fixed not-found error', async () => {
    const client = stubReviewClient();
    const root = createRootStore();
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      {
        postId: 'smp_20260713120000_00000002',
        assetId: 'sva_20260728120000_00000001',
        brief: 'brief',
      },
      {} as never,
    )).rejects.toThrow('Social post not found.');
    expect(client.calls).not.toHaveBeenCalled();
  });

  it('rejects an assetId that is not attached to the post', async () => {
    const client = stubReviewClient();
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      {
        postId: seeded.metadata.postId,
        assetId: 'sva_20260728120000_00000099',
        brief: 'brief',
      },
      {} as never,
    )).rejects.toThrow('Visual asset is not attached to this social post.');
    expect(client.calls).not.toHaveBeenCalled();
  });
});

describe('review_image tool — failure normalization', () => {
  it('resolves a provider review-failed error to an advisory pass (score 100)', async () => {
    // Review is advisory: a flaky reviewer must never block the self-review
    // loop after the image was already generated and attached. The provider
    // failure resolves to a pass instead of an error turn.
    const client: ImageReviewClient = {
      async review() {
        throw new ImageGenerationClientError('review-failed');
      },
    };
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    const result = (await tool.execute!(
      { postId: seeded.metadata.postId, assetId, brief: 'brief' },
      {} as never,
    )) as { score: number; issues: string[]; suggestion: string; postId: string; assetId: string };
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
    expect(result.suggestion).toBe('');
    expect(result.postId).toBe(seeded.metadata.postId);
    expect(result.assetId).toBe(assetId);
  });

  it('maps a non-ImageGenerationClientError thrown by the client to storage', async () => {
    const client: ImageReviewClient = {
      async review() {
        throw new Error('unexpected');
      },
    };
    const root = createRootStore();
    const seeded = seedPost(root);
    await seeded.write();
    const { assetId } = await attachOneAsset(root, seeded.metadata.postId);
    const tool = makeTool({
      reviewClient: client,
      storeFactory: () => root,
      now: FIXED_NOW,
    });

    await expect(tool.execute!(
      { postId: seeded.metadata.postId, assetId, brief: 'brief' },
      {} as never,
    )).rejects.toThrow('Visual asset storage is unavailable. Try again later.');
  });
});
