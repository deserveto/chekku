import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialPostMetadata,
  buildVisualAsset,
  createSocialPostStorage,
  ObjectStorageError,
  type ObjectStorage,
} from '@chekku/storage';

import {
  buildVisualDelegationPrompt,
  generateSocialPostVisual,
  runGenerateSocialPostVisual,
} from '../generate-social-post-visual.js';

const POST_ID = 'smp_20260819100000_00000002';

const CANONICAL_MARKDOWN = [
  '[TOPIC]',
  'AI Factory Batam',
  '',
  '[THESIS]',
  'Infrastruktur AI lokal menentukan kedaulatan data.',
  '',
  'HOOKS',
  '1. Curiosity: Siapa yang membangun pabrik AI di Batam?',
  '2. Contrarian: Stop panggil ini sekadar pabrik chip.',
  '3. Data/Impact: 170.000 akselerator AI.',
  '',
  'CORE POINTS',
  '- Kapasitas 170.000 AI accelerator.',
  '- Skala 360 MW.',
  '- Target operasional Q1 2027.',
  '',
  'SHORT-FORM BRICK',
  'AI factory mendarat di Batam.',
  '',
  'MEDIUM-FORM BRICK',
  'Refleksi panjang.',
  '',
  'IMAGE BRICK',
  'Poster teknologi deep navy dengan panel kapasitas.',
  '',
  'CALL TO ACTION / ENGAGEMENT',
  'Apa pandangan kamu?',
].join('\n');

const CAPTION_MARKDOWN = 'AI Factory di Batam bukan sekadar kabar bagus…';

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const root: ObjectStorage = {
    async createText(key, value) {
      if (objects.has(key)) throw new Error(`Already exists: ${key}`);
      objects.set(key, value);
    },
    async replaceText(key, value) {
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
  return { objects, root, social: createSocialPostStorage(root) };
}

/**
 * Seed a CANONICAL_APPROVED post with caption.md, mimicking the state the
 * caption stage (`attachCaptionToPost`) leaves behind.
 */
async function seedCaptionApprovedPost(social: ObjectStorage, options: { postMarkdown?: string } = {}) {
  const postMarkdown = options.postMarkdown
    ?? `<!-- canonical-unit -->\n${CANONICAL_MARKDOWN}\n<!-- /canonical-unit -->`;
  const built = buildSocialPostMetadata({
    postMarkdown,
    briefMarkdown: 'Brief for scheduled Instagram draft',
    topic: 'AI Factory Batam',
    status: 'DRAFT',
    postId: POST_ID,
    now: () => new Date('2026-08-19T02:00:00.000Z'),
  });
  const captionKey = `social-posts/${POST_ID}/caption.md`;
  const metadata = {
    ...built.metadata,
    status: 'CANONICAL_APPROVED' as const,
    captionObjectKey: captionKey,
    canonicalApprovedAt: '2026-08-19T03:00:00.000Z',
  };
  await social.createText(built.briefObjectKey, 'Brief for scheduled Instagram draft');
  await social.createText(built.postObjectKey, postMarkdown);
  await social.createText(captionKey, CAPTION_MARKDOWN);
  await social.createText(built.metadataObjectKey, JSON.stringify(metadata, null, 2));
  return { metadata, captionKey };
}

/**
 * Simulate the Visual Content Agent's effect on storage: the `generate_image`
 * tool attaches a visual asset to the post metadata (metadata written last).
 */
async function attachVisualLikeTheTool(social: ObjectStorage) {
  const built = buildVisualAsset({
    postId: POST_ID,
    mimeType: 'image/png',
    prompt: 'technology editorial poster',
    model: 'gemini-3.1-flash-image',
    now: () => new Date('2026-08-19T04:00:00.000Z'),
  });
  const metadataKey = `social-posts/${POST_ID}/metadata.json`;
  const current = JSON.parse(await social.getText(metadataKey));
  await social.replaceText(metadataKey, JSON.stringify({
    ...current,
    visualAssets: [built.asset],
    activeVisualAssetId: built.asset.assetId,
  }, null, 2));
}

describe('buildVisualDelegationPrompt', () => {
  it('names the tool + postId and embeds the canonical unit and caption', () => {
    const prompt = buildVisualDelegationPrompt({
      postId: POST_ID,
      canonicalMarkdown: CANONICAL_MARKDOWN,
      captionMarkdown: CAPTION_MARKDOWN,
    });
    expect(prompt).toContain(`Use generate_image with postId ${POST_ID}`);
    expect(prompt).toContain('Canonical Content Unit (source of truth)');
    expect(prompt).toContain('AI Factory Batam');
    expect(prompt).toContain('Approved Instagram caption');
    expect(prompt).toContain(CAPTION_MARKDOWN);
  });

  it('omits the caption block when no caption exists', () => {
    const prompt = buildVisualDelegationPrompt({
      postId: POST_ID,
      canonicalMarkdown: CANONICAL_MARKDOWN,
    });
    expect(prompt).not.toContain('Approved Instagram caption');
  });
});

describe('runGenerateSocialPostVisual', () => {
  it('transitions to APPROVED first, delegates to the visual agent, and reports success', async () => {
    const { objects, root, social } = createMemoryStorage();
    await seedCaptionApprovedPost(social);

    const generateVisual = vi.fn(async (_prompt: string) => {
      await attachVisualLikeTheTool(social);
      return 'Visual ready.';
    });

    const result = await runGenerateSocialPostVisual(
      { postId: POST_ID },
      { storeFactory: () => root, generateVisual },
    );

    expect(result.ok).toBe(true);
    expect(result.hasVisual).toBe(true);

    // The delegation prompt carries the postId and the canonical unit.
    expect(generateVisual).toHaveBeenCalledTimes(1);
    const prompt = generateVisual.mock.calls[0]![0] as string;
    expect(prompt).toContain(`Use generate_image with postId ${POST_ID}`);
    expect(prompt).toContain('AI Factory Batam');
    expect(prompt).toContain(CAPTION_MARKDOWN);

    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('APPROVED');
    expect(metadata.captionApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metadata.visualAssets).toHaveLength(1);
  });

  it('rejects a post that is not CANONICAL_APPROVED without touching it', async () => {
    const { objects, root, social } = createMemoryStorage();
    // Seed a post still in DRAFT (canonical stage not approved yet).
    const built = buildSocialPostMetadata({
      postMarkdown: `<!-- canonical-unit -->\n${CANONICAL_MARKDOWN}\n<!-- /canonical-unit -->`,
      briefMarkdown: 'brief',
      topic: 'AI Factory Batam',
      status: 'DRAFT',
      postId: POST_ID,
    });
    await social.createText(built.briefObjectKey, 'brief');
    await social.createText(built.postObjectKey, `<!-- canonical-unit -->\n${CANONICAL_MARKDOWN}\n<!-- /canonical-unit -->`);
    await social.createText(built.metadataObjectKey, built.metadataJson);

    const generateVisual = vi.fn();
    const result = await runGenerateSocialPostVisual(
      { postId: POST_ID },
      { storeFactory: () => root, generateVisual },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('unexpected-status-draft');
    expect(generateVisual).not.toHaveBeenCalled();
    expect(JSON.parse(await social.getText(built.metadataObjectKey)).status).toBe('DRAFT');
  });

  it('keeps APPROVED (no rollback) when the visual generation throws', async () => {
    const { objects, root, social } = createMemoryStorage();
    await seedCaptionApprovedPost(social);

    const generateVisual = vi.fn(async () => {
      throw new Error('image model unavailable');
    });

    const result = await runGenerateSocialPostVisual(
      { postId: POST_ID },
      { storeFactory: () => root, generateVisual },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('visual-generation-failed');
    const metadata = JSON.parse(await social.getText(`social-posts/${POST_ID}/metadata.json`));
    expect(metadata.status).toBe('APPROVED');
    expect(metadata.visualAssets).toBeUndefined();
  });

  it('reports no-visual-asset when the agent returns without attaching', async () => {
    const { root, social } = createMemoryStorage();
    await seedCaptionApprovedPost(social);

    const generateVisual = vi.fn(async () => 'Maaf, gagal generate.');
    const result = await runGenerateSocialPostVisual(
      { postId: POST_ID },
      { storeFactory: () => root, generateVisual },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no-visual-asset');
  });

  it('reports not-found for an unknown post', async () => {
    const { root, social } = createMemoryStorage();
    const result = await runGenerateSocialPostVisual(
      { postId: 'smp_20260819100000_deadbeef' },
      { storeFactory: () => root },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not-found');
  });
});

describe('generateSocialPostVisual workflow', () => {
  it('has id generate-social-post-visual (manual trigger only)', () => {
    expect(generateSocialPostVisual.id).toBe('generate-social-post-visual');
    expect(generateSocialPostVisual).toBeDefined();
  });
});
