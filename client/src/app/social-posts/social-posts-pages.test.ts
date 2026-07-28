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
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
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
});
