import { describe, expect, it } from 'vitest';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import type { ObjectStorage } from './objects.ts';
import {
  SOCIAL_MEDIA_AGENT_ID,
  buildSocialPostMetadata,
  createPostId,
  createSocialPostStorage,
  getSocialPost,
  keysFor,
  listSocialPosts,
  parseSocialPostTimestamp,
  type SocialPostMetadata,
} from './social-posts.ts';

const postMarkdown = `**Hook:** Hari Guru bukan sekadar tanggal.

Tulisan caption Instagram contoh.`;

const briefMarkdown = 'Topik: Hari Guru (25 Nov). Tujuan: apresiasi guru. Platform: Instagram.';

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const writes: Array<{ method: 'create' | 'replace'; key: string; value: string; contentType?: string }> = [];
  const storage: ObjectStorage = {
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
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async listKeys(prefix, options) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      const limit = options?.limit ?? keys.length;
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  return { objects, storage, writes };
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
    const approved = {
      postId,
      createdAt: '2026-07-15T11:26:44.000Z',
      platform: 'instagram',
      topic: 'Topic',
      status: 'DRAFT' as const,
      specialDay: 'Hari Guru',
      ...keysFor(postId),
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
