import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  listReports: vi.fn(),
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
vi.mock('@/server/pm-reports', () => {
  class PmReportServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    getPmReportForUser: mocks.getReport,
    listPmReportsForUser: mocks.listReports,
    PmReportServiceError,
  };
});
vi.mock('@/server/pm-report-format', async () => import('../../server/pm-report-format'));

import { PmReportServiceError } from '@/server/pm-reports';

import ReportDetailPage from './[reportId]/page';
import ReportsPage from './page';
import WeeklyReportsPage from './weekly/page';

const reportId = 'pmr_20260714120000_deadbeef';
const metadata = {
  reportId,
  createdAt: '2026-07-14T12:00:00.000Z',
  rating: 7,
  status: 'WARNING' as const,
  inputObjectKey: `pm-reports/${reportId}/input.md`,
  analysisObjectKey: `pm-reports/${reportId}/analysis.md`,
  metadataObjectKey: `pm-reports/${reportId}/metadata.json`,
};
const report = {
  reportId,
  inputMarkdown: '# Weekly input',
  analysisMarkdown: '# Analysis body',
  metadata,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listReports.mockResolvedValue([metadata]);
  mocks.getReport.mockResolvedValue(report);
});

describe('reports landing page', () => {
  it('links to grouped weekly and competitive report views', async () => {
    const markup = renderToStaticMarkup(await ReportsPage());

    expect(markup).toContain('href="/reports/weekly"');
    expect(markup).toContain('>Weekly Reports</h2>');
    expect(markup).toContain('href="/reports/competitive"');
    expect(markup).toContain('>Competitive Analyses</h2>');
    expect(mocks.listReports).not.toHaveBeenCalled();
  });

  it('gives report choices visible focus styles and one mobile column', () => {
    const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    const focusRule = css.match(/\.studio-report-choice:focus-visible\s*\{([^}]*)\}/)?.[1];
    const mobileRules = css.match(/@media \(max-width: 760px\) \{([\s\S]*)$/)?.[1] ?? '';

    expect(focusRule).toContain('outline: 2px solid var(--studio-accent)');
    expect(focusRule).toContain('outline-offset: 2px');
    expect(mobileRules).toMatch(
      /\.studio-report-choice-grid[\s\S]*grid-template-columns:\s*1fr/,
    );
  });
});

describe('weekly reports list page', () => {
  it('renders report cards in a labeled list region', async () => {
    const markup = renderToStaticMarkup(await WeeklyReportsPage());

    expect(markup).toContain('class="studio-report-grid"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('aria-label="Saved PM reports"');
    expect(markup).toContain('studio-report-card');
  });

  it('gives report cards a visible hover lift', () => {
    const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    const hoverRule = css.match(/\.studio-report-card:hover\s*\{([^}]*)\}/)?.[1];

    expect(hoverRule).toContain('transform: translateY(-2px)');
  });

  it.each([
    ['2026-07-14T14:30:00+02:30', '2026-07-14 12:00 UTC'],
    ['2026-02-30T12:00:00.000Z', '2026-02-30T12:00:00.000Z'],
    ['not a date', 'not a date'],
  ])('strictly formats or preserves createdAt %s', async (createdAt, expected) => {
    mocks.listReports.mockResolvedValue([{ ...metadata, createdAt }]);

    const markup = renderToStaticMarkup(await WeeklyReportsPage());

    expect(markup).toContain(expected);
    expect(markup).not.toContain('Invalid Date');
  });

  it('preserves encoded weekly detail links under /reports/<pmr-id>', async () => {
    const markup = renderToStaticMarkup(await WeeklyReportsPage());

    expect(markup).toContain(`href="/reports/${encodeURIComponent(reportId)}"`);
    expect(markup).not.toContain(`/reports/weekly/${reportId}`);
  });
});

describe('report detail page', () => {
  it.each(['invalid-report-id', 'not-found'] as const)(
    'uses Next notFound for %s service errors',
    async (code) => {
      mocks.getReport.mockRejectedValue(new PmReportServiceError(
        code,
        code === 'not-found' ? 404 : 400,
        code === 'not-found' ? 'Report not found.' : 'Invalid report id.',
      ));

      await expect(ReportDetailPage({
        params: Promise.resolve({ reportId }),
      })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.notFound).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['forbidden', 403, 'Authentication is required.'],
    ['storage-unavailable', 503, 'Report storage is unavailable.'],
  ] as const)('keeps a safe unavailable state for %s failures', async (
    code,
    status,
    message,
  ) => {
    mocks.getReport.mockRejectedValue(new PmReportServiceError(
      code,
      status,
      message,
    ));

    const markup = renderToStaticMarkup(await ReportDetailPage({
      params: Promise.resolve({ reportId }),
    }));

    expect(markup).toContain('Report unavailable');
    expect(markup).toContain(message);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('uses headings to label analysis, metadata, and original input', async () => {
    const markup = renderToStaticMarkup(await ReportDetailPage({
      params: Promise.resolve({ reportId }),
    }));
    const analysisIndex = markup.indexOf('>Analysis</h2>');
    const metadataIndex = markup.indexOf('>Metadata</h2>');
    const inputIndex = markup.indexOf('>Original report input</h2>');

    expect(markup).toMatch(/<h2[^>]*>Analysis<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*>Metadata<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*>Original report input<\/h2>/);
    expect(analysisIndex).toBeGreaterThan(-1);
    expect(metadataIndex).toBeGreaterThan(analysisIndex);
    expect(inputIndex).toBeGreaterThan(metadataIndex);
  });
});
