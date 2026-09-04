import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownMessage } from '@/components/markdown-message';
import { ReportTabs } from '@/components/reports/report-tabs';
import {
  getPmReportForUser,
  PmReportServiceError,
} from '@/server/pm-reports';

export const dynamic = 'force-dynamic';

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  let report: Awaited<ReturnType<typeof getPmReportForUser>> | undefined;
  let errorMessage: string | undefined;

  try {
    report = await getPmReportForUser(reportId);
  } catch (error) {
    if (
      error instanceof PmReportServiceError
      && (error.code === 'invalid-report-id' || error.code === 'not-found')
    ) {
      notFound();
    }
    errorMessage = error instanceof PmReportServiceError
      ? error.message
      : 'Could not load report.';
  }

  if (!report) {
    return (
      <>
          <header className="studio-page-header">
            <div>
              <p className="studio-eyebrow">PM report</p>
              <h1>Report unavailable</h1>
            </div>
            <Link className="studio-button" href="/reports/weekly">Back to reports</Link>
          </header>
          <section className="studio-section">
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage ?? 'Could not load report.'}
            </div>
          </section>
    </>
    );
  }

  return (
    <>
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">PM report · Weekly review</p>
            <h1>Weekly risk review</h1>
            <p className="studio-report-id"><code>{report.reportId}</code></p>
            <div className="studio-agent-meta-chips" style={{ margin: '12px 0 0', paddingTop: 0, borderTop: 0 }}>
              <span className="studio-meta-chip"><i className="studio-dot ready" aria-hidden="true" /> Rating {report.metadata.rating}/10</span>
              <span className="studio-meta-chip">{report.metadata.status}</span>
              <span className="studio-meta-chip">{new Date(report.metadata.createdAt).toISOString().slice(0, 10)}</span>
            </div>
          </div>
          <Link className="studio-button" href="/reports/weekly">Back to reports</Link>
        </header>

        <div className="studio-report-detail-wrap">
          <ReportTabs active="weekly" />
          <div className="studio-report-detail">
          <section className="studio-report-analysis studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Primary document</p>
              <h2>Analysis</h2>
            </div>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={report.analysisMarkdown} />
            </div>
          </section>

          <section className="studio-report-context studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Technical context</p>
              <h2>Metadata</h2>
            </div>
            <pre className="studio-report-metadata">
              {JSON.stringify(report.metadata, null, 2)}
            </pre>
          </section>

          <section className="studio-report-context studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Source</p>
              <h2>Original report input</h2>
            </div>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={report.inputMarkdown} />
            </div>
          </section>
          </div>
        </div>
    </>
  );
}
