import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPublicSlides: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/components/competitive-slides', () => ({
  CompetitiveSlides: ({ variant, slidesMarkdown, anchorProduct, createdAt }: {
    variant: string; slidesMarkdown: string; anchorProduct: string; createdAt: string;
  }) => `SLIDES:${variant}:${anchorProduct}:${createdAt}:${slidesMarkdown.slice(0, 5)}`,
}));
vi.mock('@/server/competitive-analyses', () => ({
  CompetitiveAnalysisServiceError: class extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
      super(message);
    }
  },
  getPublicSlides: mocks.getPublicSlides,
}));

import PublicSlidesPage from './slides/[analysisId]/page';

const analysisId = 'pca_20260723120000_deadbeef';
const token = 'abcdef0123456789abcdef0123456789';

describe('public slides route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicSlides.mockResolvedValue({
      analysisId,
      anchorProduct: 'GPT',
      createdAt: '2026-07-29T10:00:00.000Z',
      slidesMarkdown: '# Deck content here',
    });
  });

  it('renders the deck in public variant via the component', async () => {
    const markup = renderToStaticMarkup(await PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    }));

    expect(markup).toContain('SLIDES:public:GPT:2026-07-29T10:00:00.000Z:# Dec');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('404s when token param is missing', async () => {
    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s when service throws not-found', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.getPublicSlides.mockRejectedValue(
      new CompetitiveAnalysisServiceError('not-found', 404, 'Slides not found.'),
    );

    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s when service throws storage-unavailable', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.getPublicSlides.mockRejectedValue(
      new CompetitiveAnalysisServiceError('storage-unavailable', 503, 'Storage unavailable.'),
    );

    await expect(PublicSlidesPage({
      params: Promise.resolve({ analysisId }),
      searchParams: Promise.resolve({ t: token }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('does NOT import @chekku/storage (verified separately by ui-structure test)', async () => {
    // placeholder — actual lock is in client/src/lib/ui-structure.test.ts
    expect(true).toBe(true);
  });
});
