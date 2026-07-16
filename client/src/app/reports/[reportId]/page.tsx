import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownMessage } from '@/components/markdown-message';
import { StudioNav } from '@/components/studio/studio-nav';
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
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
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
      <div className="studio-shell">
        <StudioNav resourceId={resourceId} />
        <main className="studio-main">
          <header className="studio-page-header">
            <div>
              <p className="studio-eyebrow">PM report</p>
              <h1>Report unavailable</h1>
            </div>
            <Link className="studio-button" href="/reports">Back to reports</Link>
          </header>
          <section className="studio-section">
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage ?? 'Could not load report.'}
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">PM report</p>
            <h1>{report.reportId}</h1>
            <p>Saved analysis first, followed by storage metadata and original input.</p>
          </div>
          <Link className="studio-button" href="/reports">Back to reports</Link>
        </header>

        <div className="studio-report-detail">
          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Analysis</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={report.analysisMarkdown} />
            </div>
          </section>

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Metadata</h2>
            <pre className="studio-report-metadata">
              {JSON.stringify(report.metadata, null, 2)}
            </pre>
          </section>

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Original report input</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={report.inputMarkdown} />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
