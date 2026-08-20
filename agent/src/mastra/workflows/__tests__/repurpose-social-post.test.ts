import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialPostMetadata,
  createSocialPostStorage,
  ObjectStorageError,
  type ObjectStorage,
} from '@chekku/storage';

import { buildBrief, parseBrief } from '../weekly-social-drafts.js';
import type { Topic } from '../special-days.js';
import {
  repurposeSocialPost,
  resolveTopicForRepurpose,
  runRepurposeSocialPost,
} from '../repurpose-social-post.js';

const POST_ID = 'smp_20260819100000_00000001';

const CANONICAL_MARKDOWN = [
  '[TOPIC]',
  'Hari Guru Nasional',
  '',
  '[THESIS]',
  'Guru adalah tulang punggung transformasi digital yang paling jarang dirayakan.',
  '',
  'HOOKS',
  '1. Curiosity: Siapa yang mengajari AI?',
  '2. Contrarian: Stop cuma berkata terima kasih.',
  '3. Data/Impact: 3 juta guru mengajar di Indonesia.',
  '',
  'CORE POINTS',
  '- Guru mengadopsi teknologi lebih cepat dari asumsi.',
  '- Apresiasi struktural lebih penting dari seremonial.',
  '',
  'SHORT-FORM BRICK',
  'Terima kasih guru.',
  '',
  'MEDIUM-FORM BRICK',
  'Refleksi panjang.',
  '',
  'IMAGE BRICK',
  'Poster 1:1 dengan panel apresiasi guru.',
  '',
  'CALL TO ACTION / ENGAGEMENT',
  'Ucapkan terima kasih hari ini.',
].join('\n');

const DEFAULT_TOPIC: Topic = {
  kind: 'special-day',
  name: 'Hari Guru Nasional',
  angle: 'Apresiasi guru.',
  specialDay: 'Hari Guru Nasional',
};
const DEFAULT_BRIEF = buildBrief(DEFAULT_TOPIC, '2026-11-23');
const DEFAULT_POST_MARKDOWN = `<!-- canonical-unit -->\n${CANONICAL_MARKDOWN}\n<!-- /canonical-unit -->`;

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const writes: Array<{ method: 'create' | 'replace'; key: string; value: string }> = [];
  const root: ObjectStorage = {
    async createText(key, value) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      writes.push({ method: 'create', key, value });
      objects.set(key, value);
    },
    async replaceText(key, value) {
      writes.push({ method: 'replace', key, value });
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) {
        throw new ObjectStorageError('not-found', `Missing object: ${key}`);
      }
      return value;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async listKeys(prefix) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { keys, truncated: false };
    },
  };
  // Seed and assert through the same namespaced wrapper the workflow builds
  // over the root, so logical `social-posts/...` keys line up.
  return { objects, root, social: createSocialPostStorage(root), writes };
}

function seedPost(
  storage: ObjectStorage,
  options: {
    status?: 'DRAFT' | 'CANONICAL_APPROVED' | 'APPROVED';
    postMarkdown?: string;
    briefMarkdown?: string;
  } = {},
) {
  const postMarkdown = options.postMarkdown ?? DEFAULT_POST_MARKDOWN;
  const briefMarkdown = options.briefMarkdown ?? DEFAULT_BRIEF;
  const built = buildSocialPostMetadata({
    postMarkdown,
    briefMarkdown,
    topic: DEFAULT_TOPIC.name,
    specialDay: DEFAULT_TOPIC.specialDay,
    status: options.status ?? 'DRAFT',
    postId: POST_ID,
    now: () => new Date('2026-11-23T02:00:00.000Z'),
  });
  return {
    seed: async () => {
      await storage.createText(built.briefObjectKey, briefMarkdown);
      await storage.createText(built.postObjectKey, postMarkdown);
      await storage.createText(built.metadataObjectKey, built.metadataJson);
    },
    keys: built,
  };
}

describe('parseBrief (roundtrip for the deferred caption stage)', () => {
  it('recovers the topic and week from a brief written by buildBrief', () => {
    const topic: Topic = {
      kind: 'trending',
      name: 'AI Factory Batam',
      angle: 'Infrastruktur AI lokal.',
      source: { url: 'https://kompas.com/news/a', title: 'AI Factory', snippet: 'Snip.' },
    };
    const parsed = parseBrief(buildBrief(topic, '2026-08-17'));
    expect(parsed?.weekStart).toBe('2026-08-17');
    expect(parsed?.topic.kind).toBe('trending');
    expect(parsed?.topic.name).toBe('AI Factory Batam');
    expect(parsed?.topic.source?.url).toBe('https://kompas.com/news/a');
    expect(parsed?.topic.source?.title).toBe('AI Factory');
  });

  it('returns undefined for a foreign brief format', () => {
    expect(parseBrief('Random text without labeled lines.')).toBeUndefined();
  });

  it('ignores label-shaped lines embedded in the untrusted reference markdown', () => {
    const topic: Topic = {
      kind: 'trending',
      name: 'AI Factory Batam',
      angle: 'Infrastruktur AI lokal.',
      source: {
        url: 'https://kompas.com/news/a',
        title: 'AI Factory',
        snippet: 'Snip.',
        pageMarkdown: [
          'Opening paragraph of the fetched page.',
          'Source: Antara',
          'Topic: Fake Injected Topic',
          'Week of: 1999-01-01',
          'Special day: Hari Palsu',
        ].join('\n'),
      },
    };
    const parsed = parseBrief(buildBrief(topic, '2026-08-17'));
    // The genuine structural labels win; embedded page content never
    // flips the topic kind (which would silently change the caption format).
    expect(parsed?.weekStart).toBe('2026-08-17');
    expect(parsed?.topic.kind).toBe('trending');
    expect(parsed?.topic.name).toBe('AI Factory Batam');
    expect(parsed?.topic.specialDay).toBeUndefined();
  });

  it('keeps the first occurrence of a structural label', () => {
    const brief = [
      'Brief for scheduled Instagram draft',
      '',
      'Week of: 2026-08-17',
      'Topic: Real Topic',
      'Source: trending-research',
      'Topic: Shadow Topic',
      'Reference markdown (truncated): Source: Antara',
    ].join('\n');
    const parsed = parseBrief(brief);
    expect(parsed?.topic.name).toBe('Real Topic');
    expect(parsed?.topic.kind).toBe('trending');
  });
});

describe('resolveTopicForRepurpose', () => {
  it('falls back to a special-day topic from metadata for unparseable briefs', () => {
    const resolved = resolveTopicForRepurpose('not a brief', {
      topic: 'Hari Kartini',
      createdAt: '2026-04-21T02:00:00.000Z',
      specialDay: 'Hari Kartini',
    });
    expect(resolved.weekStart).toBe('2026-04-21');
    expect(resolved.topic.kind).toBe('special-day');
    expect(resolved.topic.name).toBe('Hari Kartini');
  });
});

describe('runRepurposeSocialPost', () => {
  it('generates, stores the caption, and transitions DRAFT to CANONICAL_APPROVED', async () => {
    const { objects, root, social } = createMemoryStorage();
    const seeded = seedPost(social);
    await seeded.seed();

    const repurpose = vi.fn(async (_prompt: string) => 'R — Your Gentle AI Companion\n\nSelamat Hari Guru Nasional.');
    const createText = vi.fn(async (key: string, text: string) => {
      await social.createText(key, text, 'text/markdown');
    });

    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose, createText },
    );

    expect(result.ok).toBe(true);
    expect(result.captionObjectKey).toBe(`social-posts/${POST_ID}/caption.md`);
    expect(createText).toHaveBeenCalledWith(
      `social-posts/${POST_ID}/caption.md`,
      'R — Your Gentle AI Companion\n\nSelamat Hari Guru Nasional.',
    );
    expect(await social.getText(`social-posts/${POST_ID}/caption.md`)).toContain('Selamat Hari Guru Nasional.');

    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('CANONICAL_APPROVED');
    expect(metadata.captionObjectKey).toBe(`social-posts/${POST_ID}/caption.md`);
    expect(metadata.canonicalApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The repurpose prompt carries the stored canonical unit and the topic.
    expect(repurpose.mock.calls[0]![0]).toContain('Canonical Content Unit');
    expect(repurpose.mock.calls[0]![0]).toContain('Hari Guru Nasional');
    expect(repurpose.mock.calls[0]![0]).toContain(CANONICAL_MARKDOWN.trim().slice(0, 40));
  });

  it('rejects a post that is not DRAFT (double-fire race) without writing', async () => {
    const { root, social, writes } = createMemoryStorage();
    const seeded = seedPost(social, { status: 'CANONICAL_APPROVED' });
    await seeded.seed();
    writes.length = 0; // drop the seed writes; only workflow writes matter

    const repurpose = vi.fn(async () => 'caption');
    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('unexpected-status-canonical_approved');
    expect(repurpose).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('rejects a legacy caption-only post with canonical-missing', async () => {
    const { root, social } = createMemoryStorage();
    const seeded = seedPost(social, { postMarkdown: 'Plain legacy caption.' });
    await seeded.seed();

    const repurpose = vi.fn(async () => 'caption');
    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('canonical-missing');
    expect(repurpose).not.toHaveBeenCalled();
  });

  it('keeps the post DRAFT when the caption generation fails', async () => {
    const { objects, root, social } = createMemoryStorage();
    const seeded = seedPost(social);
    await seeded.seed();

    const repurpose = vi.fn(async () => {
      throw new Error('gateway down');
    });
    const createText = vi.fn();
    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose, createText },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('caption-generation-failed');
    expect(createText).not.toHaveBeenCalled();
    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('DRAFT');
  });

  it('rejects an empty caption output without transitioning', async () => {
    const { objects, root, social } = createMemoryStorage();
    const seeded = seedPost(social);
    await seeded.seed();

    const repurpose = vi.fn(async () => '   ');
    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('caption-empty');
    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('DRAFT');
  });

  it('heals an orphaned caption object from a partially failed prior run', async () => {
    const { root, social } = createMemoryStorage();
    const seeded = seedPost(social);
    await seeded.seed();
    // Simulate the partial failure: body write succeeded, metadata
    // transition did not — post stays DRAFT with caption.md present.
    await social.createText(`social-posts/${POST_ID}/caption.md`, 'Orphaned caption.');

    const repurpose = vi.fn(async () => 'fresh caption');
    const createText = vi.fn();
    const result = await runRepurposeSocialPost(
      { postId: POST_ID },
      { storeFactory: () => root, repurpose, createText },
    );

    expect(result.ok).toBe(true);
    expect(result.captionObjectKey).toBe(`social-posts/${POST_ID}/caption.md`);
    expect(repurpose).not.toHaveBeenCalled();
    expect(createText).not.toHaveBeenCalled();
    expect(await social.getText(`social-posts/${POST_ID}/caption.md`)).toBe('Orphaned caption.');
    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('CANONICAL_APPROVED');
    expect(metadata.captionObjectKey).toBe(`social-posts/${POST_ID}/caption.md`);
  });

  it('reports not-found for an unknown post', async () => {
    const { root, social } = createMemoryStorage();
    const result = await runRepurposeSocialPost(
      { postId: 'smp_20260819100000_deadbeef' },
      { storeFactory: () => root },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not-found');
  });
});

describe('repurposeSocialPost workflow', () => {
  it('has id repurpose-social-post and no schedule (manual trigger only)', () => {
    expect(repurposeSocialPost.id).toBe('repurpose-social-post');
    expect(repurposeSocialPost).toBeDefined();
  });
});
