import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';
import { formatPmReportCreatedAt } from '@/server/pm-report-format';
import {
  listPmReportsForUser,
  PmReportServiceError,
} from '@/server/pm-reports';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
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
              className="studio-report-table-wrap studio-panel"
              tabIndex={0}
              role="region"
              aria-label="Saved PM reports"
            >
              <table className="studio-report-table">
                <thead>
                  <tr>
                    <th>Report id</th>
                    <th>Created</th>
                    <th>Rating</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={report.reportId}>
                      <td>
                        <Link href={`/reports/${encodeURIComponent(report.reportId)}`}>
                          {report.reportId}
                        </Link>
                      </td>
                      <td>{formatPmReportCreatedAt(report.createdAt)}</td>
                      <td>{report.rating}/10</td>
                      <td>{report.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
