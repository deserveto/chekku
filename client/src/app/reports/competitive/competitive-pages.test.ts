import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAnalysis: vi.fn(),
  listAnalyses: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth', () => ({
  requireUserId: async () => 'local-user',
  getUserId: async () => 'local-user',
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/components/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => `MARKDOWN:${content}`,
}));
vi.mock('@/components/studio/studio-nav', () => ({ StudioNav: () => null }));
vi.mock('@/components/competitive-slides', () => ({
  CompetitiveSlides: ({ slidesMarkdown, analysisId }: { slidesMarkdown: string; analysisId: string }) =>
    `SLIDES:${analysisId}:${slidesMarkdown.slice(0, 6)}`,
}));
vi.mock('@/server/competitive-analyses', () => {
  class CompetitiveAnalysisServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    getCompetitiveAnalysisForUser: mocks.getAnalysis,
    listCompetitiveAnalysesForUser: mocks.listAnalyses,
    CompetitiveAnalysisServiceError,
  };
});
vi.mock('@/server/pm-report-format', async () => import('../../../server/pm-report-format'));

import { CompetitiveAnalysisServiceError } from '@/server/competitive-analyses';

import CompetitiveAnalysisDetailPage from './[analysisId]/page';
import CompetitiveSlidesPage from './[analysisId]/slides/page';
import CompetitiveAnalysesPage from './page';

const analysisId = 'pca_20260723120000_deadbeef';
const metadata = {
  analysisId,
  createdAt: '2026-07-23T12:00:00.000Z',
  anchorProduct: 'GPT',
  market: 'AI assistants',
  competitorNames: ['Claude', 'Gemini', 'Copilot', 'Perplexity', 'Meta AI'],
  productCount: 6,
  sourceCount: 6,
  requestObjectKey: `competitive-analyses/${analysisId}/request.md`,
  analysisObjectKey: `competitive-analyses/${analysisId}/analysis.md`,
  metadataObjectKey: `competitive-analyses/${analysisId}/metadata.json`,
};
const analysis = {
  analysisId,
  requestMarkdown: '/competitive-analysis GPT',
  analysisMarkdown: '# Competitive Analysis: GPT',
  metadata,
};

const slidesMarkdown = '---\nmarp: true\n---\n# Deck';

const analysisWithSlides = {
  ...analysis,
  slidesMarkdown,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAnalyses.mockResolvedValue([metadata]);
  mocks.getAnalysis.mockResolvedValue(analysis);
});

describe('competitive analyses list page', () => {
  it('renders report cards in a labeled list with analysis metadata', async () => {
    const markup = renderToStaticMarkup(await CompetitiveAnalysesPage());

    expect(markup).toContain('class="studio-report-grid"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('aria-label="Saved competitive analyses"');
    expect(markup).toContain('studio-report-card');
    expect(markup).toContain(`/reports/competitive/${analysisId}`);
    expect(markup).toContain('<h3>GPT</h3>');
    expect(markup).toContain('<dd>5</dd>');
    expect(markup).toContain('<dd>6</dd>');
  });

  it('renders exact empty state', async () => {
    mocks.listAnalyses.mockResolvedValue([]);

    const markup = renderToStaticMarkup(await CompetitiveAnalysesPage());

    expect(markup).toContain('No saved competitive analyses');
    expect(markup).toContain('Completed PM Agent competitive analyses will appear here after they are stored.');
  });

  it.each([
    ['storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
    ['forbidden', 403, 'Authentication is required.'],
  ] as const)('renders safe %s list errors', async (code, status, message) => {
    mocks.listAnalyses.mockRejectedValue(new CompetitiveAnalysisServiceError(code, status, message));

    const markup = renderToStaticMarkup(await CompetitiveAnalysesPage());

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(message);
  });

  it('renders a Slides badge on each card', async () => {
    mocks.listAnalyses.mockResolvedValue([metadata]);

    const markup = renderToStaticMarkup(await CompetitiveAnalysesPage());

    expect(markup).toContain('Slides');
    expect(markup).toContain(`/reports/competitive/${analysisId}/slides`);
  });
});

describe('competitive analysis detail page', () => {
  it.each(['invalid-analysis-id', 'not-found'] as const)(
    'uses Next notFound for %s service errors',
    async (code) => {
      mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(
        code,
        code === 'not-found' ? 404 : 400,
        code === 'not-found' ? 'Competitive analysis not found.' : 'Invalid analysis id.',
      ));

      await expect(CompetitiveAnalysisDetailPage({
        params: Promise.resolve({ analysisId }),
      })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.notFound).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['forbidden', 403, 'Authentication is required.'],
    ['storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
  ] as const)('keeps a safe unavailable state for %s failures', async (code, status, message) => {
    mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(code, status, message));

    const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('Competitive analysis unavailable');
    expect(markup).toContain(message);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('renders analysis, metadata, and original request in order', async () => {
    const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
      params: Promise.resolve({ analysisId }),
    }));
    const analysisIndex = markup.indexOf('>Analysis</h2>');
    const metadataIndex = markup.indexOf('>Metadata</h2>');
    const requestIndex = markup.indexOf('>Original request</h2>');

    expect(analysisIndex).toBeGreaterThan(-1);
    expect(metadataIndex).toBeGreaterThan(analysisIndex);
    expect(requestIndex).toBeGreaterThan(metadataIndex);
    expect(markup).toContain(`MARKDOWN:${analysis.analysisMarkdown}`);
    expect(markup).toContain(`MARKDOWN:${analysis.requestMarkdown}`);
    expect(markup).toContain('&quot;anchorProduct&quot;: &quot;GPT&quot;');
    expect(markup).toContain('href="/reports/competitive"');
  });

  it('renders a View slides button when slidesMarkdown is present', async () => {
    mocks.getAnalysis.mockResolvedValue(analysisWithSlides);

    const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('View slides');
    expect(markup).toContain(`/reports/competitive/${analysisId}/slides`);
  });

  it('hides the View slides button when slidesMarkdown is missing (legacy)', async () => {
    mocks.getAnalysis.mockResolvedValue({ ...analysis, slidesMarkdown: undefined });

    const markup = renderToStaticMarkup(await CompetitiveAnalysisDetailPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).not.toContain('View slides');
  });
});

describe('competitive analysis slides route', () => {
  it('404s when analysis is missing slidesMarkdown', async () => {
    mocks.getAnalysis.mockResolvedValue({ ...analysis });

    await expect(CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it('404s when analysis service returns invalid-analysis-id or not-found', async () => {
    mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(
      'not-found', 404, 'Competitive analysis not found.',
    ));

    await expect(CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the slides component when slidesMarkdown present', async () => {
    mocks.getAnalysis.mockResolvedValue(analysisWithSlides);

    const markup = renderToStaticMarkup(await CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('SLIDES:pca_20260723120000_deadbeef:---\nma');
    expect(markup).toContain('Back to analysis');
    expect(markup).toContain(`href="/reports/competitive/${analysisId}"`);
  });

  it.each([
    ['forbidden', 403, 'Authentication is required.'],
    ['storage-unavailable', 503, 'Competitive analysis storage is unavailable.'],
  ] as const)('renders safe error for %s service failure', async (code, status, message) => {
    mocks.getAnalysis.mockRejectedValue(new CompetitiveAnalysisServiceError(code, status, message));

    const markup = renderToStaticMarkup(await CompetitiveSlidesPage({
      params: Promise.resolve({ analysisId }),
    }));

    expect(markup).toContain('Slides unavailable');
    expect(markup).toContain(message);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
