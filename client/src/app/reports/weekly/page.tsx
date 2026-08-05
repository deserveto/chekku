import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';
import { requireUserId } from '@/server/auth';
import { formatPmReportCreatedAt } from '@/server/pm-report-format';
import {
  listPmReportsForUser,
  PmReportServiceError,
} from '@/server/pm-reports';

export const dynamic = 'force-dynamic';

export default async function WeeklyReportsPage() {
  const resourceId = await requireUserId();
  let reports: Awaited<ReturnType<typeof listPmReportsForUser>> = [];
  let errorMessage: string | undefined;

  try {
    reports = await listPmReportsForUser();
  } catch (error) {
    errorMessage = error instanceof PmReportServiceError
      ? error.message
      : 'Could not load reports.';
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header">
          <div>
            <p className="studio-eyebrow">Garage storage</p>
            <h1>PM reports</h1>
            <p>Review saved project analysis, risk ratings, and original weekly input.</p>
          </div>
        </header>

        <section className="studio-section">
          {errorMessage ? (
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage}
            </div>
          ) : reports.length === 0 ? (
            <div className="studio-empty-state">
              <h3>No saved reports</h3>
              <p>PM Agent reports will appear here after they are stored.</p>
            </div>
          ) : (
            <div
              className="studio-report-grid"
              role="list"
              aria-label="Saved PM reports"
            >
              {reports.map((report) => (
                <article className="studio-report-card" role="listitem" key={report.reportId}>
                  <div className="studio-agent-card-top">
                    <span className="studio-agent-glyph" aria-hidden="true">◇</span>
                    <span className="studio-source-badge">{report.status}</span>
                  </div>

                  <div>
                    <h3>{formatPmReportCreatedAt(report.createdAt)}</h3>
                    <code>{report.reportId}</code>
                  </div>

                  <dl className="studio-agent-meta">
                    <div>
                      <dt>Rating</dt>
                      <dd>{report.rating}/10</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{report.status}</dd>
                    </div>
                  </dl>

                  <div className="studio-card-actions">
                    <Link
                      className="studio-button studio-button-primary"
                      href={`/reports/${encodeURIComponent(report.reportId)}`}
                    >
                      View report
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
