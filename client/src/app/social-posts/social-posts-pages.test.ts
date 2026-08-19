import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPost: vi.fn(),
  listPosts: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth', () => ({
  requireUserId: async () => 'local-user',
  getUserId: async () => 'local-user',
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => content,
}));
vi.mock('@/components/studio/studio-nav', () => ({ StudioNav: () => null }));
vi.mock('@/server/social-posts', () => {
  class SocialPostServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    getSocialPostForUser: mocks.getPost,
    listSocialPostsForUser: mocks.listPosts,
    SocialPostServiceError,
  };
});
vi.mock('@/server/social-post-format', async () => import('../../server/social-post-format'));
vi.mock('@/lib/post-markdown', async () => import('../../lib/post-markdown'));

import { SocialPostServiceError } from '@/server/social-posts';

import SocialPostDetailPage from './[postId]/page';
import SocialPostsPage from './page';

const postId = 'smp_20260714120000_deadbeef';
const metadata = {
  postId,
  createdAt: '2026-07-14T12:00:00.000Z',
  platform: 'instagram',
  topic: 'Hari Guru Nasional',
  specialDay: 'Hari Guru Nasional',
  status: 'DRAFT' as const,
  postObjectKey: `social-posts/${postId}/post.md`,
  briefObjectKey: `social-posts/${postId}/brief.md`,
  metadataObjectKey: `social-posts/${postId}/metadata.json`,
};
const post = {
  postId,
  postMarkdown: '# Caption body',
  briefMarkdown: '# Brief body',
  metadata,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPosts.mockResolvedValue([metadata]);
  mocks.getPost.mockResolvedValue(post);
});

describe('social posts list page', () => {
  it('renders its table in a labeled keyboard-scrollable region', async () => {
    const markup = renderToStaticMarkup(await SocialPostsPage());

    expect(markup).toContain('class="studio-report-table-wrap studio-panel"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Saved social posts"');
  });

  it('gives the post table region a visible focus style (shared report-table CSS)', () => {
    const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    const focusRule = css.match(
      /\.studio-report-table-wrap:focus-visible\s*\{([^}]*)\}/,
    )?.[1];

    expect(focusRule).toContain('outline: 1px solid var(--studio-ink)');
    expect(focusRule).toContain('outline-offset: 2px');
  });

  it.each([
    ['2026-07-14T14:30:00+02:30', '2026-07-14 12:00 UTC'],
    ['2026-02-30T12:00:00.000Z', '2026-02-30T12:00:00.000Z'],
    ['not a date', 'not a date'],
  ])('strictly formats or preserves createdAt %s', async (createdAt, expected) => {
    mocks.listPosts.mockResolvedValue([{ ...metadata, createdAt }]);

    const markup = renderToStaticMarkup(await SocialPostsPage());

    expect(markup).toContain(`<td>${expected}</td>`);
    expect(markup).not.toContain('Invalid Date');
  });
});

describe('social post detail page', () => {
  it.each(['invalid-post-id', 'not-found'] as const)(
    'uses Next notFound for %s service errors',
    async (code) => {
      mocks.getPost.mockRejectedValue(new SocialPostServiceError(
        code,
        code === 'not-found' ? 404 : 400,
        code === 'not-found' ? 'Social post not found.' : 'Invalid social post id.',
      ));

      await expect(SocialPostDetailPage({
        params: Promise.resolve({ postId }),
      })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.notFound).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['forbidden', 403, 'Authentication is required.'],
    ['storage-unavailable', 503, 'Social post storage is unavailable.'],
  ] as const)('keeps a safe unavailable state for %s failures', async (
    code,
    status,
    message,
  ) => {
    mocks.getPost.mockRejectedValue(new SocialPostServiceError(
      code,
      status,
      message,
    ));

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).toContain('Draft unavailable');
    expect(markup).toContain(message);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('uses headings to label caption, metadata, and brief in order', async () => {
    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));
    const captionIndex = markup.indexOf('>Caption</h2>');
    const metadataIndex = markup.indexOf('>Metadata</h2>');
    const briefIndex = markup.indexOf('>Brief</h2>');

    expect(markup).toMatch(/<h2[^>]*>Caption<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*>Metadata<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*>Brief<\/h2>/);
    expect(captionIndex).toBeGreaterThan(-1);
    expect(metadataIndex).toBeGreaterThan(captionIndex);
    expect(briefIndex).toBeGreaterThan(metadataIndex);
  });

  it('omits the visual section when the post has no visual assets', async () => {
    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).not.toContain('>Visual</h2>');
    expect(markup).not.toContain('studio-visual-image');
  });

  it('shows the Approve Canonical button for a canonical-only DRAFT post', async () => {
    mocks.getPost.mockResolvedValue({
      ...post,
      postMarkdown: '<!-- canonical-unit -->\n[TOPIC]\nHari Guru\n\n[THESIS]\nGuru penting.\n<!-- /canonical-unit -->',
    });

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).toContain('>Approve Canonical<');
    expect(markup).not.toContain('>Approve Caption<');
    // Canonical-only draft: the caption section explains the deferred stage.
    expect(markup).toContain('The caption is generated after the canonical content is approved.');
  });

  it('shows the caption pending indicator for a CANONICAL_APPROVED post without a caption', async () => {
    mocks.getPost.mockResolvedValue({
      ...post,
      postMarkdown: '<!-- canonical-unit -->\n[TOPIC]\nHari Guru\n\n[THESIS]\nGuru penting.\n<!-- /canonical-unit -->',
      metadata: { ...metadata, status: 'CANONICAL_APPROVED' as const },
    });

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).toContain('Generating caption…');
    expect(markup).not.toContain('>Approve Caption<');
    expect(markup).not.toContain('>Approve Canonical<');
  });

  it('shows the Approve Caption button once the caption exists', async () => {
    mocks.getPost.mockResolvedValue({
      ...post,
      postMarkdown: '<!-- canonical-unit -->\n[TOPIC]\nHari Guru\n\n[THESIS]\nGuru penting.\n<!-- /canonical-unit -->',
      captionMarkdown: 'Selamat Hari Guru Nasional.',
      metadata: {
        ...metadata,
        status: 'CANONICAL_APPROVED' as const,
        captionObjectKey: `social-posts/${postId}/caption.md`,
      },
    });

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).toContain('>Approve Caption<');
    expect(markup).toContain('Selamat Hari Guru Nasional.');
    expect(markup).not.toContain('>Approve Canonical<');
  });

  it('shows the image pending indicator for an APPROVED post without visuals', async () => {
    mocks.getPost.mockResolvedValue({
      ...post,
      captionMarkdown: 'Selamat Hari Guru Nasional.',
      metadata: {
        ...metadata,
        status: 'APPROVED' as const,
        captionObjectKey: `social-posts/${postId}/caption.md`,
      },
    });

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).toContain('Generating image…');
    expect(markup).not.toContain('>Approve Caption<');
    expect(markup).not.toContain('>Approve Canonical<');
  });

  it('hides every approve control for APPROVED posts', async () => {
    mocks.getPost.mockResolvedValue({
      ...post,
      metadata: { ...metadata, status: 'APPROVED' as const },
    });

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    expect(markup).not.toContain('>Approve<');
    expect(markup).not.toContain('>Approve Caption<');
    expect(markup).not.toContain('>Approve Canonical<');
  });

  it('renders the active visual asset image between caption and metadata', async () => {
    const assetId = 'sva_20260728120000_0000000a';
    const postWithVisual = {
      ...post,
      metadata: {
        ...metadata,
        status: 'APPROVED' as const,
        visualAssets: [{
          assetId,
          objectKey: `social-posts/${postId}/visuals/${assetId}.png`,
          imageUrl: `/api/storage/social-posts/${postId}/visuals/${assetId}`,
          mimeType: 'image/png',
          generatedAt: '2026-07-28T12:00:00.000Z',
          model: 'gemini-3.1-flash-image',
          prompt: 'soft morning light',
        }],
        activeVisualAssetId: assetId,
      },
    };
    mocks.getPost.mockResolvedValue(postWithVisual);

    const markup = renderToStaticMarkup(await SocialPostDetailPage({
      params: Promise.resolve({ postId }),
    }));

    const captionIndex = markup.indexOf('>Caption</h2>');
    const visualIndex = markup.indexOf('>Visual</h2>');
    const metadataIndex = markup.indexOf('>Metadata</h2>');

    expect(visualIndex).toBeGreaterThan(-1);
    expect(visualIndex).toBeGreaterThan(captionIndex);
    expect(metadataIndex).toBeGreaterThan(visualIndex);
    expect(markup).toContain('src="/api/storage/social-posts/smp_20260714120000_deadbeef/visuals/sva_20260728120000_0000000a"');
    expect(markup).toContain('alt="Generated visual sva_20260728120000_0000000a');
    expect(markup).toContain('gemini-3.1-flash-image');
  });
});
