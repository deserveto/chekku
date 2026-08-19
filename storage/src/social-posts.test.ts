import { describe, expect, it } from 'vitest';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import type { BinaryObjectResult, BinaryObjectStorage, ObjectStorage } from './objects.ts';
import {
  SOCIAL_MEDIA_AGENT_ID,
  attachCaptionToPost,
  attachVisualAsset,
  buildSocialPostMetadata,
  buildVisualAsset,
  createPostId,
  createSocialPostStorage,
  createVisualAssetId,
  extensionForMimeType,
  getSocialPost,
  isVisualAssetId,
  keysFor,
  listSocialPosts,
  parseSocialPostTimestamp,
  readVisualAssetBytes,
  updateSocialPostStatus,
  visualAssetImageUrl,
  visualAssetKeys,
  VISUAL_ASSET_ID_RE,
  type SocialPostMetadata,
  type SocialVisualAsset,
} from './social-posts.ts';

const postMarkdown = `**Hook:** Hari Guru bukan sekadar tanggal.

Tulisan caption Instagram contoh.`;

const briefMarkdown = 'Topik: Hari Guru (25 Nov). Tujuan: apresiasi guru. Platform: Instagram.';

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  const writes: Array<{ method: 'create' | 'replace'; key: string; value: string; contentType?: string }> = [];
  const storage: BinaryObjectStorage = {
    async createText(key, value, contentType) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      writes.push({ method: 'create', key, value, contentType });
      objects.set(key, value);
    },
    async replaceText(key, value, contentType) {
      writes.push({ method: 'replace', key, value, contentType });
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error(`Missing object: ${key}`);
      return value;
    },
    async exists(key) {
      return objects.has(key) || bytes.has(key);
    },
    async delete(key) {
      objects.delete(key);
      bytes.delete(key);
    },
    async listKeys(prefix, options) {
      const keys = [...objects.keys(), ...bytes.keys()].filter((key) => key.startsWith(prefix));
      const limit = options?.limit ?? keys.length;
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
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
      if (!entry) throw new Error(`Missing object: ${key}`);
      return { value: new Uint8Array(entry.value), ...(entry.contentType ? { contentType: entry.contentType } : {}) };
    },
  };
  return { objects, bytes, storage, writes };
}

/**
 * Seed a post through the read path's expected layout by writing the three
 * canonical objects directly. The workflow's writer goes through Garage MCP;
 * here we exercise the storage layer at the same shape so list/get tests
 * reflect what the writer produces.
 */
async function seedPost(
  storage: ObjectStorage,
  input: {
    postMarkdown?: string;
    briefMarkdown?: string;
    topic: string;
    platform?: 'instagram';
    specialDay?: string;
    status?: 'DRAFT' | 'APPROVED' | 'PUBLISHED';
    postId?: string;
    createdAt?: string;
  },
): Promise<SocialPostMetadata> {
  const built = buildSocialPostMetadata({
    postMarkdown: input.postMarkdown ?? postMarkdown,
    briefMarkdown: input.briefMarkdown ?? briefMarkdown,
    topic: input.topic,
    platform: input.platform,
    specialDay: input.specialDay,
    status: input.status,
    postId: input.postId,
    ...(input.createdAt ? { now: () => new Date(input.createdAt!) } : {}),
  });
  await storage.createText(built.briefObjectKey, input.briefMarkdown ?? briefMarkdown, 'text/markdown');
  await storage.createText(built.postObjectKey, input.postMarkdown ?? postMarkdown, 'text/markdown');
  await storage.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
  return built.metadata;
}

describe('buildSocialPostMetadata', () => {
  it('defaults platform to instagram, status to DRAFT, and generates a canonical postId', () => {
    const built = buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Hari Kartini',
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(built.metadata.platform).toBe('instagram');
    expect(built.metadata.status).toBe('DRAFT');
    expect(built.metadata.postId).toMatch(/^smp_20260713120000_[0-9a-f]{8}$/);
    expect(built.metadata.specialDay).toBeUndefined();
    expect(built.metadataJson).toBe(JSON.stringify(built.metadata, null, 2));
  });

  it('preserves specialDay only when provided and exposes canonical object keys', () => {
    const built = buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Hari Guru',
      specialDay: 'Hari Guru',
      postId: 'smp_20260713120000_00000001',
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    expect(built.metadata.specialDay).toBe('Hari Guru');
    expect(built.metadata.postObjectKey).toBe('social-posts/smp_20260713120000_00000001/post.md');
    expect(built.metadata.briefObjectKey).toBe('social-posts/smp_20260713120000_00000001/brief.md');
    expect(built.metadata.metadataObjectKey).toBe('social-posts/smp_20260713120000_00000001/metadata.json');
    expect(built.postObjectKey).toBe(built.metadata.postObjectKey);
    expect(built.briefObjectKey).toBe(built.metadata.briefObjectKey);
    expect(built.metadataObjectKey).toBe(built.metadata.metadataObjectKey);
  });

  it('rejects a blank topic before producing any keys', () => {
    expect(() => buildSocialPostMetadata({ postMarkdown, briefMarkdown, topic: '   ' })).toThrow(
      'Social post topic must not be blank.',
    );
  });

  it('rejects unsupported platform and status values', () => {
    expect(() => buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Topic',
      platform: 'tiktok' as never,
    })).toThrow('Unsupported social platform: tiktok');
    expect(() => buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Topic',
      status: 'ARCHIVED' as never,
    })).toThrow('Unsupported social post status: ARCHIVED');
  });

  it('rejects an invalid explicit postId via keysFor', () => {
    expect(() => buildSocialPostMetadata({ postMarkdown, briefMarkdown, topic: 'Topic', postId: 'smp_legacy' })).toThrow(
      'Invalid social post id: smp_legacy',
    );
  });
});

describe('social post storage', () => {
  it('uses the social-media-agent namespace via createSocialPostStorage', async () => {
    const { objects, storage } = createMemoryStorage();
    const store = createSocialPostStorage(storage);

    await seedPost(store, {
      topic: 'Hari Guru',
      specialDay: 'Hari Guru',
      postId: 'smp_20260713120000_00000001',
      createdAt: '2026-07-13T12:00:00.000Z',
    });

    expect(SOCIAL_MEDIA_AGENT_ID).toBe('social-media-agent');
    expect([...objects.keys()]).toContain(
      `agents/${Buffer.from('social-media-agent').toString('base64url')}/social-posts/smp_20260713120000_00000001/metadata.json`,
    );
  });

  it('does not list a partial save without metadata', async () => {
    const { storage } = createMemoryStorage();
    await storage.createText('social-posts/smp_20260713120000_00000002/brief.md', 'brief');
    await storage.createText('social-posts/smp_20260713120000_00000002/post.md', postMarkdown);

    await expect(listSocialPosts(storage)).resolves.toEqual([]);
  });

  it('isolates social posts from another agent namespace', async () => {
    const { storage } = createMemoryStorage();
    const socialStore = createSocialPostStorage(storage);
    const foreignStore = createNamespacedObjectStorage(storage, 'other-agent');
    await seedPost(socialStore, { topic: 'Social', postId: 'smp_20260713120000_00000003' });
    await seedPost(foreignStore, { topic: 'Foreign', postId: 'smp_20260713120000_00000004' });

    await expect(listSocialPosts(socialStore)).resolves.toMatchObject([{ postId: 'smp_20260713120000_00000003' }]);
    await expect(getSocialPost(socialStore, 'smp_20260713120000_00000004')).rejects.toThrow('Missing object');
  });

  it('lists post metadata newest first', async () => {
    const { storage } = createMemoryStorage();
    await seedPost(storage, { topic: 'Old', postId: 'smp_20260713100000_00000005', createdAt: '2026-07-13T10:00:00.000Z' });
    await seedPost(storage, { topic: 'New', postId: 'smp_20260713110000_00000006', createdAt: '2026-07-13T11:00:00.000Z' });

    expect((await listSocialPosts(storage)).map((post) => post.postId)).toEqual(['smp_20260713110000_00000006', 'smp_20260713100000_00000005']);
  });

  it('rejects truncated object listings instead of returning an incomplete post list', async () => {
    const { storage } = createMemoryStorage();
    const truncatedStorage: ObjectStorage = {
      ...storage,
      async listKeys() {
        return { keys: [], truncated: true };
      },
    };

    await expect(listSocialPosts(truncatedStorage)).rejects.toThrow(
      'Cannot list all social posts: object storage truncated the social-posts/ listing. Increase the storage listing limit.',
    );
  });

  it.each([
    ['2026-07-15T11:26:42.7Z', Date.UTC(2026, 6, 15, 11, 26, 42, 700)],
    ['2026-07-15T11:26:42.123456789z', Date.UTC(2026, 6, 15, 11, 26, 42, 123)],
    ['2026-07-15t11:26:42z', Date.UTC(2026, 6, 15, 11, 26, 42)],
    ['2026-07-15t13:56:42.987654321+02:30', Date.UTC(2026, 6, 15, 11, 26, 42, 987)],
    ['2026-07-15T06:26:42-05:00', Date.UTC(2026, 6, 15, 11, 26, 42)],
  ])('parses timestamp %s and truncates fractions to milliseconds', (createdAt, expected) => {
    expect(parseSocialPostTimestamp(createdAt)).toBe(expected);
  });

  it.each([
    '2026-02-30T11:26:42.123456Z',
    '2025-02-29t11:26:42.123456z',
    '2026-13-01T00:00:00Z',
    '2026-07-15T13:56:42+0230',
  ])('rejects invalid RFC3339 timestamp %s', (createdAt) => {
    expect(parseSocialPostTimestamp(createdAt)).toBeUndefined();
  });

  it('sorts valid timestamps first and retains source order for invalid or equal instants', async () => {
    const { objects, storage } = createMemoryStorage();
    const metadata = (postId: string, createdAt: string) => ({
      postId,
      createdAt,
      platform: 'instagram',
      topic: 'Topic',
      status: 'DRAFT',
      ...keysFor(postId),
    });
    objects.set('social-posts/smp_20260715112640_00000007/metadata.json', JSON.stringify(metadata('smp_20260715112640_00000007', '2026-02-30T11:26:00.000Z')));
    objects.set('social-posts/smp_20260715112642_00000008/metadata.json', JSON.stringify(metadata('smp_20260715112642_00000008', '2026-07-15T11:26:42.1239Z')));
    objects.set('social-posts/smp_20260715112641_00000009/metadata.json', JSON.stringify(metadata('smp_20260715112641_00000009', 'not a date')));
    objects.set('social-posts/smp_20260715112643_0000000a/metadata.json', JSON.stringify(metadata('smp_20260715112643_0000000a', '2026-07-15T11:26:42.1231Z')));

    expect((await listSocialPosts(storage)).map((post) => [post.postId, post.createdAt])).toEqual([
      ['smp_20260715112642_00000008', '2026-07-15T11:26:42.1239Z'],
      ['smp_20260715112643_0000000a', '2026-07-15T11:26:42.1231Z'],
      ['smp_20260715112640_00000007', '2026-02-30T11:26:00.000Z'],
      ['smp_20260715112641_00000009', 'not a date'],
    ]);
  });

  it('skips malformed metadata but retains otherwise valid invalid createdAt strings', async () => {
    const { objects, storage } = createMemoryStorage();
    const validId = 'smp_20260715112644_0000000b';
    const valid = { postId: validId, createdAt: 'invalid date', platform: 'instagram', topic: 'Topic', status: 'DRAFT', ...keysFor(validId) };
    objects.set(valid.metadataObjectKey, JSON.stringify(valid));
    objects.set('social-posts/smp_corrupt/metadata.json', '{not-json');
    objects.set('social-posts/smp_bad_id/metadata.json', JSON.stringify({ ...valid, postId: 'bad_id' }));
    objects.set('social-posts/smp_bad_key/metadata.json', JSON.stringify({ ...valid, postId: 'smp_bad_key' }));
    objects.set('social-posts/smp_20260715112645_0000000c/metadata.json', JSON.stringify({ ...valid, postId: 'smp_20260715112645_0000000c', platform: 'tiktok', ...keysFor('smp_20260715112645_0000000c') }));
    objects.set('social-posts/smp_20260715112646_0000000d/metadata.json', JSON.stringify({ ...valid, postId: 'smp_20260715112646_0000000d', status: 'ARCHIVED', ...keysFor('smp_20260715112646_0000000d') }));

    await expect(listSocialPosts(storage)).resolves.toEqual([valid]);
  });

  it('projects untrusted metadata to approved fields for lists and reads', async () => {
    const { objects, storage } = createMemoryStorage();
    const postId = 'smp_20260715112644_00000010';
    // A DRAFT post carries no caption fields — strip the caption key the
    // deterministic layout now also returns.
    const { captionObjectKey: _captionKey, ...fixedKeys } = keysFor(postId);
    const approved = {
      postId,
      createdAt: '2026-07-15T11:26:44.000Z',
      platform: 'instagram',
      topic: 'Topic',
      status: 'DRAFT' as const,
      specialDay: 'Hari Guru',
      ...fixedKeys,
    };
    const hostile = {
      ...approved,
      postUrl: 'https://attacker.example/post',
      physicalObjectKey: 'agents/c29jaWFsLW1lZGlhLWFnZW50/private',
      nested: { arbitrary: ['secret'] },
    };
    objects.set(approved.briefObjectKey, briefMarkdown);
    objects.set(approved.postObjectKey, postMarkdown);
    objects.set(approved.metadataObjectKey, JSON.stringify(hostile));

    await expect(listSocialPosts(storage)).resolves.toEqual([approved]);
    await expect(getSocialPost(storage, postId)).resolves.toEqual({
      postId,
      postMarkdown,
      briefMarkdown,
      metadata: approved,
    });
  });

  it('skips internally consistent metadata with a noncanonical post id', async () => {
    const { objects, storage } = createMemoryStorage();
    const postId = 'smp_20260715112642_deadbeef';
    const valid = {
      postId,
      createdAt: '2026-07-15T11:26:42.000Z',
      platform: 'instagram',
      topic: 'Topic',
      status: 'DRAFT',
      ...keysFor(postId),
    };
    const noncanonical = {
      ...valid,
      postId: 'smp_legacy',
      postObjectKey: 'social-posts/smp_legacy/post.md',
      briefObjectKey: 'social-posts/smp_legacy/brief.md',
      metadataObjectKey: 'social-posts/smp_legacy/metadata.json',
    };
    objects.set(valid.metadataObjectKey, JSON.stringify(valid));
    objects.set(noncanonical.metadataObjectKey, JSON.stringify(noncanonical));

    await expect(listSocialPosts(storage)).resolves.toEqual([valid]);
  });

  it('propagates metadata read failures while safely rejecting invalid read metadata', async () => {
    const { objects, storage } = createMemoryStorage();
    const postId = 'smp_20260715112647_0000000e';
    await seedPost(storage, { topic: 'Topic', postId });
    const failingStorage: ObjectStorage = { ...storage, async getText() { throw new Error('Garage access denied'); } };
    await expect(listSocialPosts(failingStorage)).rejects.toThrow('Garage access denied');

    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify({ postId }));
    await expect(getSocialPost(storage, postId)).rejects.toThrow(`Invalid social post metadata for ${postId}`);
  });

  it('reads a saved post', async () => {
    const { storage } = createMemoryStorage();
    const postId = 'smp_20260715112648_0000000f';
    const metadata = await seedPost(storage, {
      topic: 'Hari Guru',
      specialDay: 'Hari Guru',
      postId,
    });

    await expect(getSocialPost(storage, postId)).resolves.toEqual({
      postId,
      postMarkdown,
      briefMarkdown,
      metadata,
    });
  });

  it('builds a canonical id from a UTC timestamp', () => {
    expect(createPostId(new Date('2026-07-15T11:26:42.000Z'))).toMatch(/^smp_20260715112642_[0-9a-f]{8}$/);
  });

  it.each([
    '../escape',
    'smp_bad/id',
    'post',
    'smp_',
    'smp_legacy',
    'smp_20260715112642_DEADBEEF',
    'smp_20260715112642_deadbeef_extra',
  ])('rejects invalid post id %s at every boundary', async (postId) => {
    const { storage } = createMemoryStorage();
    expect(() => keysFor(postId)).toThrow(`Invalid social post id: ${postId}`);
    expect(() => buildSocialPostMetadata({ postMarkdown, briefMarkdown, topic: 'Topic', postId })).toThrow(`Invalid social post id: ${postId}`);
    await expect(getSocialPost(storage, postId)).rejects.toThrow(`Invalid social post id: ${postId}`);
  });
});

describe('visual asset helpers', () => {
  it('builds a canonical visual asset id from a UTC timestamp', () => {
    expect(createVisualAssetId(new Date('2026-07-28T11:26:42.000Z'))).toMatch(/^sva_20260728112642_[0-9a-f]{8}$/);
  });

  it('recognizes canonical visual asset ids', () => {
    expect(isVisualAssetId('sva_20260728112642_deadbeef')).toBe(true);
    expect(isVisualAssetId('sva_legacy')).toBe(false);
    expect(isVisualAssetId('')).toBe(false);
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'maps %s to its file extension',
    (mimeType) => {
      expect(extensionForMimeType(mimeType)).toMatch(/^(png|jpg|webp)$/);
    },
  );

  it('derives deterministic object key and application url from ids and mime type', () => {
    const postId = 'smp_20260713120000_00000001';
    const assetId = 'sva_20260728120000_0000000a';
    expect(visualAssetKeys(postId, assetId, 'image/png')).toEqual({
      objectKey: 'social-posts/smp_20260713120000_00000001/visuals/sva_20260728120000_0000000a.png',
      imageUrl: '/api/storage/social-posts/smp_20260713120000_00000001/visuals/sva_20260728120000_0000000a',
    });
    expect(visualAssetImageUrl(postId, assetId)).toBe(
      '/api/storage/social-posts/smp_20260713120000_00000001/visuals/sva_20260728120000_0000000a',
    );
  });

  it('rejects invalid ids and mime types before producing keys', () => {
    expect(() => visualAssetKeys('smp_legacy', 'sva_20260728120000_0000000a', 'image/png')).toThrow(
      'Invalid social post id: smp_legacy',
    );
    expect(() => visualAssetKeys('smp_20260713120000_00000001', 'sva_legacy', 'image/png')).toThrow(
      'Invalid visual asset id: sva_legacy',
    );
    expect(() => visualAssetKeys('smp_20260713120000_00000001', 'sva_20260728120000_0000000a', 'image/gif' as never)).toThrow(
      'Unsupported visual MIME type',
    );
  });

  it('builds a pure visual asset with deterministic keys', () => {
    const built = buildVisualAsset({
      postId: 'smp_20260713120000_00000001',
      assetId: 'sva_20260728120000_0000000a',
      mimeType: 'image/jpeg',
      prompt: 'warm sunlight on a desk',
      model: 'gemini-3.1-flash-image',
      width: 1024,
      height: 1280,
      generatedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(built.asset).toEqual({
      assetId: 'sva_20260728120000_0000000a',
      objectKey: 'social-posts/smp_20260713120000_00000001/visuals/sva_20260728120000_0000000a.jpg',
      imageUrl: '/api/storage/social-posts/smp_20260713120000_00000001/visuals/sva_20260728120000_0000000a',
      mimeType: 'image/jpeg',
      generatedAt: '2026-07-28T12:00:00.000Z',
      model: 'gemini-3.1-flash-image',
      prompt: 'warm sunlight on a desk',
      width: 1024,
      height: 1280,
    });
  });

  it('rejects an oversized prompt before producing any keys', () => {
    expect(() => buildVisualAsset({
      postId: 'smp_20260713120000_00000001',
      assetId: 'sva_20260728120000_0000000a',
      mimeType: 'image/png',
      prompt: 'x'.repeat(2_001),
      model: 'gemini-3.1-flash-image',
    })).toThrow('Visual prompt must be a string of at most 2,000 UTF-8 bytes.');
  });
});

describe('visual asset metadata parsing', () => {
  const postId = 'smp_20260715112642_00000008';
  const validAsset = (overrides: Partial<SocialVisualAsset> = {}): SocialVisualAsset => ({
    assetId: 'sva_20260728120000_0000000a',
    objectKey: `social-posts/${postId}/visuals/sva_20260728120000_0000000a.png`,
    imageUrl: `/api/storage/social-posts/${postId}/visuals/sva_20260728120000_0000000a`,
    mimeType: 'image/png',
    generatedAt: '2026-07-28T12:00:00.000Z',
    model: 'gemini-3.1-flash-image',
    prompt: 'soft morning light',
    ...overrides,
  });

  function metadataWith(visual: unknown, activeId?: unknown) {
    return {
      postId,
      createdAt: '2026-07-15T11:26:42.000Z',
      platform: 'instagram',
      topic: 'Topic',
      status: 'APPROVED',
      ...keysFor(postId),
      ...(visual !== undefined ? { visualAssets: visual } : {}),
      ...(activeId !== undefined ? { activeVisualAssetId: activeId } : {}),
    };
  }

  it('parses legacy metadata without visuals unchanged', async () => {
    const { objects, storage } = createMemoryStorage();
    const base = metadataWith(undefined);
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(base));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toBeUndefined();
    expect(post.activeVisualAssetId).toBeUndefined();
  });

  it('parses metadata with one visual asset', async () => {
    const { objects, storage } = createMemoryStorage();
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([validAsset()], 'sva_20260728120000_0000000a')));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toEqual([validAsset()]);
    expect(post.activeVisualAssetId).toBe('sva_20260728120000_0000000a');
  });

  it('parses metadata with multiple revisions preserving order', async () => {
    const { objects, storage } = createMemoryStorage();
    const first = validAsset();
    const second = validAsset({
      assetId: 'sva_20260728130000_0000000b',
      objectKey: `social-posts/${postId}/visuals/sva_20260728130000_0000000b.png`,
      imageUrl: `/api/storage/social-posts/${postId}/visuals/sva_20260728130000_0000000b`,
      generatedAt: '2026-07-28T13:00:00.000Z',
      prompt: 'revision two',
    });
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([first, second], second.assetId)));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toEqual([first, second]);
    expect(post.activeVisualAssetId).toBe(second.assetId);
  });

  it('drops malformed visual entries but keeps valid ones in the same post', async () => {
    const { objects, storage } = createMemoryStorage();
    const good = validAsset();
    const badMimeType = { ...validAsset(), mimeType: 'image/gif', objectKey: `social-posts/${postId}/visuals/sva_20260728120000_0000000a.gif` };
    const badKey = { ...validAsset(), objectKey: 'arbitrary/escape/key' };
    const badId = { ...validAsset(), assetId: 'sva_legacy' };
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([badMimeType, good, badKey, badId])));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toEqual([good]);
    expect(post.activeVisualAssetId).toBeUndefined();
  });

  it('drops activeVisualAssetId that does not reference a kept asset', async () => {
    const { objects, storage } = createMemoryStorage();
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([validAsset()], 'sva_20260728990000_missing')));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.activeVisualAssetId).toBeUndefined();
  });

  it('rejects metadata whose visual object key is not deterministic for the post', async () => {
    const { objects, storage } = createMemoryStorage();
    const crossPost = validAsset({
      assetId: 'sva_20260728120000_0000000a',
      objectKey: 'social-posts/smp_20260715112642_00000009/visuals/sva_20260728120000_0000000a.png',
      imageUrl: '/api/storage/social-posts/smp_20260715112642_00000009/visuals/sva_20260728120000_0000000a',
    });
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([crossPost])));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toBeUndefined();
  });

  it('does not persist base64 or arbitrary hostile fields through the parser', async () => {
    const { objects, storage } = createMemoryStorage();
    const hostile = {
      ...validAsset(),
      dataUrl: 'data:image/png;base64,iVBOR...',
      credential: 'AKIA-SECRET',
      nested: { arbitrary: ['secret'] },
    };
    objects.set(`social-posts/${postId}/metadata.json`, JSON.stringify(metadataWith([hostile], hostile.assetId)));

    const post = (await listSocialPosts(storage))[0]!;
    expect(post.visualAssets).toEqual([validAsset()]);
    expect(JSON.stringify(post)).not.toMatch(/base64|AKIA-SECRET|secret/);
  });

  it('serializes the canonical metadata deterministically', () => {
    const asset = validAsset();
    const metadata: SocialPostMetadata = {
      postId,
      createdAt: '2026-07-15T11:26:42.000Z',
      platform: 'instagram',
      topic: 'Topic',
      status: 'APPROVED',
      ...keysFor(postId),
      visualAssets: [asset],
      activeVisualAssetId: asset.assetId,
    };
    expect(JSON.parse(JSON.stringify(metadata, null, 2))).toEqual(metadata);
  });
});

describe('attachVisualAsset and readVisualAssetBytes', () => {
  const postId = 'smp_20260715112648_0000000f';

  async function seedApprovedPost(storage: ObjectStorage): Promise<SocialPostMetadata> {
    const built = buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Hari Guru',
      status: 'APPROVED',
      postId,
    });
    await storage.createText(built.briefObjectKey, briefMarkdown, 'text/markdown');
    await storage.createText(built.postObjectKey, postMarkdown, 'text/markdown');
    await storage.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
    return built.metadata;
  }

  it('appends a new visual asset, sets it active, and writes metadata last', async () => {
    const { storage, writes } = createMemoryStorage();
    await seedApprovedPost(storage);

    const built = buildVisualAsset({
      postId,
      mimeType: 'image/png',
      prompt: 'soft morning light',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    const imageBytes = new Uint8Array([1, 2, 3]);
    await storage.createBytes(built.objectKey, imageBytes, 'image/png');

    const lastWriteBefore = writes.length;
    const updated = await attachVisualAsset(storage, postId, built.asset);

    expect(updated.visualAssets).toEqual([built.asset]);
    expect(updated.activeVisualAssetId).toBe(built.asset.assetId);
    expect(writes.length).toBe(lastWriteBefore + 1);
    expect(writes[writes.length - 1]).toMatchObject({
      method: 'replace',
      key: `social-posts/${postId}/metadata.json`,
      contentType: 'application/json',
    });
  });

  it('preserves the previous asset when appending a revision', async () => {
    const { storage } = createMemoryStorage();
    await seedApprovedPost(storage);

    const first = buildVisualAsset({
      postId,
      mimeType: 'image/png',
      prompt: 'first attempt',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    await storage.createBytes(first.objectKey, new Uint8Array([1]), 'image/png');
    await attachVisualAsset(storage, postId, first.asset);

    const second = buildVisualAsset({
      postId,
      mimeType: 'image/jpeg',
      prompt: 'revision',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T13:00:00.000Z'),
    });
    await storage.createBytes(second.objectKey, new Uint8Array([2]), 'image/jpeg');
    const updated = await attachVisualAsset(storage, postId, second.asset);

    expect(updated.visualAssets?.map((a) => a.assetId)).toEqual([first.asset.assetId, second.asset.assetId]);
    expect(updated.activeVisualAssetId).toBe(second.asset.assetId);
  });

  it('reads stored bytes with the asset mime type as content type', async () => {
    const { storage } = createMemoryStorage();
    await seedApprovedPost(storage);

    const built = buildVisualAsset({
      postId,
      mimeType: 'image/webp',
      prompt: 'webp visual',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    const imageBytes = new Uint8Array([9, 9, 9]);
    await storage.createBytes(built.objectKey, imageBytes, 'image/webp');
    await attachVisualAsset(storage, postId, built.asset);

    await expect(readVisualAssetBytes(storage, postId, built.asset.assetId)).resolves.toEqual({
      value: imageBytes,
      contentType: 'image/webp',
    });
  });

  it('rejects reading an asset id that does not belong to the post', async () => {
    const { storage } = createMemoryStorage();
    await seedApprovedPost(storage);

    await expect(readVisualAssetBytes(storage, postId, 'sva_20260728120000_missing')).rejects.toThrow(
      'not found',
    );
  });

  it('does not attach the same asset id twice', async () => {
    const { storage } = createMemoryStorage();
    await seedApprovedPost(storage);

    const built = buildVisualAsset({
      postId,
      mimeType: 'image/png',
      prompt: 'once',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    await storage.createBytes(built.objectKey, new Uint8Array([1]), 'image/png');
    await attachVisualAsset(storage, postId, built.asset);

    await expect(attachVisualAsset(storage, postId, built.asset)).rejects.toThrow('already attached');
  });

  it('serializes concurrent attachments so both revisions are preserved', async () => {
    const { storage } = createMemoryStorage();
    await seedApprovedPost(storage);

    const first = buildVisualAsset({
      postId,
      mimeType: 'image/png',
      prompt: 'first attempt',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    const second = buildVisualAsset({
      postId,
      mimeType: 'image/jpeg',
      prompt: 'second attempt',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T13:00:00.000Z'),
    });
    await storage.createBytes(first.objectKey, new Uint8Array([1]), 'image/png');
    await storage.createBytes(second.objectKey, new Uint8Array([2]), 'image/jpeg');

    const [a, b] = await Promise.all([
      attachVisualAsset(storage, postId, first.asset),
      attachVisualAsset(storage, postId, second.asset),
    ]);

    // Each call resolved with its own asset present (neither was lost in flight).
    expect(a.visualAssets?.some((entry) => entry.assetId === first.asset.assetId)).toBe(true);
    expect(b.visualAssets?.some((entry) => entry.assetId === second.asset.assetId)).toBe(true);

    // The persisted metadata holds both revisions; under the old non-serialized
    // RMW the second write would have clobbered the first and orphaned its bytes.
    const post = await getSocialPost(storage, postId);
    expect(post.metadata.visualAssets?.map((entry) => entry.assetId).sort()).toEqual(
      [first.asset.assetId, second.asset.assetId].sort(),
    );
  });
});

describe('attachCaptionToPost', () => {
  const postId = 'smp_20260715112647_0000000e';

  async function seedDraftPost(storage: ObjectStorage) {
    const built = buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Hari Guru',
      status: 'DRAFT',
      postId,
    });
    await storage.createText(built.briefObjectKey, briefMarkdown, 'text/markdown');
    await storage.createText(built.postObjectKey, postMarkdown, 'text/markdown');
    await storage.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
    return built.metadata;
  }

  it('transitions DRAFT to CANONICAL_APPROVED and records the caption key + timestamp', async () => {
    const { storage, writes } = createMemoryStorage();
    await seedDraftPost(storage);
    await storage.createText(`social-posts/${postId}/caption.md`, 'Caption baru.', 'text/markdown');

    const updated = await attachCaptionToPost(storage, postId, {
      now: () => new Date('2026-08-19T09:00:00.000Z'),
    });

    expect(updated.status).toBe('CANONICAL_APPROVED');
    expect(updated.captionObjectKey).toBe(`social-posts/${postId}/caption.md`);
    expect(updated.canonicalApprovedAt).toBe('2026-08-19T09:00:00.000Z');
    const lastWrite = writes[writes.length - 1]!;
    expect(lastWrite.method).toBe('replace');
    expect(lastWrite.key).toBe(`social-posts/${postId}/metadata.json`);
  });

  it('makes getSocialPost return the stored caption markdown', async () => {
    const { storage } = createMemoryStorage();
    await seedDraftPost(storage);
    await storage.createText(`social-posts/${postId}/caption.md`, 'Caption baru.', 'text/markdown');
    await attachCaptionToPost(storage, postId);

    const post = await getSocialPost(storage, postId);
    expect(post.metadata.status).toBe('CANONICAL_APPROVED');
    expect(post.captionMarkdown).toBe('Caption baru.');
  });

  it('omits captionMarkdown for posts without a caption stage', async () => {
    const { storage } = createMemoryStorage();
    await seedDraftPost(storage);

    const post = await getSocialPost(storage, postId);
    expect(post.metadata.status).toBe('DRAFT');
    expect(post.captionMarkdown).toBeUndefined();
  });

  it('rejects a post that is not DRAFT (double-fire race)', async () => {
    const { storage } = createMemoryStorage();
    await seedDraftPost(storage);
    await storage.createText(`social-posts/${postId}/caption.md`, 'Caption.', 'text/markdown');
    await attachCaptionToPost(storage, postId);

    await expect(attachCaptionToPost(storage, postId)).rejects.toThrow(
      'Cannot attach a caption to social post',
    );
  });

  it('rejects an invalid post id', async () => {
    const { storage } = createMemoryStorage();
    await expect(attachCaptionToPost(storage, 'smp_legacy')).rejects.toThrow(
      'Invalid social post id',
    );
  });
});

describe('updateSocialPostStatus', () => {
  const postId = 'smp_20260715112648_0000000f';

  async function seedPostWithStatus(
    storage: ObjectStorage,
    status: 'DRAFT' | 'CANONICAL_APPROVED' | 'APPROVED' | 'PUBLISHED',
  ) {
    const built = buildSocialPostMetadata({
      postMarkdown,
      briefMarkdown,
      topic: 'Hari Guru',
      status,
      postId,
    });
    await storage.createText(built.briefObjectKey, briefMarkdown, 'text/markdown');
    await storage.createText(built.postObjectKey, postMarkdown, 'text/markdown');
    await storage.createText(built.metadataObjectKey, built.metadataJson, 'application/json');
    if (status === 'CANONICAL_APPROVED' || status === 'APPROVED' || status === 'PUBLISHED') {
      const current = JSON.parse(built.metadataJson) as SocialPostMetadata;
      const withCaption: SocialPostMetadata = {
        ...current,
        status,
        captionObjectKey: `social-posts/${postId}/caption.md`,
        ...(status !== 'CANONICAL_APPROVED' ? { canonicalApprovedAt: '2026-08-19T09:00:00.000Z' } : {}),
      };
      await storage.createText(`social-posts/${postId}/caption.md`, 'Caption.', 'text/markdown');
      await storage.replaceText(built.metadataObjectKey, JSON.stringify(withCaption, null, 2), 'application/json');
    }
    return built.metadata;
  }

  it('transitions CANONICAL_APPROVED to APPROVED, stamps captionApprovedAt, and writes metadata back', async () => {
    const { storage, writes } = createMemoryStorage();
    await seedPostWithStatus(storage, 'CANONICAL_APPROVED');

    const updated = await updateSocialPostStatus(storage, postId, 'APPROVED');

    expect(updated.status).toBe('APPROVED');
    expect(updated.captionApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated.captionObjectKey).toBe(`social-posts/${postId}/caption.md`);
    const lastWrite = writes[writes.length - 1]!;
    expect(lastWrite.method).toBe('replace');
    expect(lastWrite.key).toBe(`social-posts/${postId}/metadata.json`);
  });

  it('persists the new status so a fresh read sees APPROVED', async () => {
    const { storage } = createMemoryStorage();
    await seedPostWithStatus(storage, 'CANONICAL_APPROVED');
    await updateSocialPostStatus(storage, postId, 'APPROVED');

    const post = await getSocialPost(storage, postId);
    expect(post.metadata.status).toBe('APPROVED');
  });

  it('preserves visual assets and other fields through the transition', async () => {
    const { storage } = createMemoryStorage();
    await seedPostWithStatus(storage, 'CANONICAL_APPROVED');
    const built = buildVisualAsset({
      postId,
      mimeType: 'image/png',
      prompt: 'test',
      model: 'gemini-3.1-flash-image',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    await storage.createBytes(built.objectKey, new Uint8Array([1]), 'image/png');
    await attachVisualAsset(storage, postId, built.asset);

    const updated = await updateSocialPostStatus(storage, postId, 'APPROVED');

    expect(updated.visualAssets?.length).toBe(1);
    expect(updated.activeVisualAssetId).toBe(built.asset.assetId);
    expect(updated.topic).toBe('Hari Guru');
  });

  it('rejects the direct DRAFT → APPROVED jump (2-stage approval)', async () => {
    const { storage } = createMemoryStorage();
    await seedPostWithStatus(storage, 'DRAFT');

    await expect(updateSocialPostStatus(storage, postId, 'APPROVED')).rejects.toThrow(
      'Cannot transition social post',
    );
  });

  it('rejects transitioning an already-APPROVED post', async () => {
    const { storage } = createMemoryStorage();
    await seedPostWithStatus(storage, 'APPROVED');

    await expect(updateSocialPostStatus(storage, postId, 'APPROVED')).rejects.toThrow(
      'Cannot transition social post',
    );
  });

  it('rejects transitioning to PUBLISHED', async () => {
    const { storage } = createMemoryStorage();
    await seedPostWithStatus(storage, 'CANONICAL_APPROVED');

    await expect(updateSocialPostStatus(storage, postId, 'PUBLISHED')).rejects.toThrow(
      'Cannot transition social post',
    );
  });

  it('rejects an invalid post id', async () => {
    const { storage } = createMemoryStorage();
    await expect(updateSocialPostStatus(storage, 'smp_legacy', 'APPROVED')).rejects.toThrow(
      'Invalid social post id',
    );
  });
});
