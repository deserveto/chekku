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

import { PmReportServiceError } from '@/server/pm-reports';

import ReportDetailPage from './[reportId]/page';
import ReportsPage from './page';

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

describe('reports list page', () => {
  it('renders its table in a labeled keyboard-scrollable region', async () => {
    const markup = renderToStaticMarkup(await ReportsPage());

    expect(markup).toContain('class="studio-report-table-wrap studio-panel"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Saved PM reports"');
  });

  it('gives the report table region a visible focus style', () => {
    const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
    const focusRule = css.match(
      /\.studio-report-table-wrap:focus-visible\s*\{([^}]*)\}/,
    )?.[1];

    expect(focusRule).toContain('outline: 1px solid var(--studio-ink)');
    expect(focusRule).toContain('outline-offset: 2px');
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
