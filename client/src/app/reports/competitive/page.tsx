import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';
import {
  CompetitiveAnalysisServiceError,
  listCompetitiveAnalysesForUser,
} from '@/server/competitive-analyses';
import { formatPmReportCreatedAt } from '@/server/pm-report-format';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysesPage() {
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
  let analyses: Awaited<ReturnType<typeof listCompetitiveAnalysesForUser>> = [];
  let errorMessage: string | undefined;

  try {
    analyses = await listCompetitiveAnalysesForUser();
  } catch (error) {
    errorMessage = error instanceof CompetitiveAnalysisServiceError
      ? error.message
      : 'Could not load competitive analyses.';
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header">
          <div>
            <p className="studio-eyebrow">Garage storage</p>
            <h1>Competitive analyses</h1>
            <p>Review saved product comparisons, evidence, feature matrices, and recommendations.</p>
          </div>
          <Link className="studio-button" href="/reports">All reports</Link>
        </header>

        <section className="studio-section">
          {errorMessage ? (
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage}
            </div>
          ) : analyses.length === 0 ? (
            <div className="studio-empty-state">
              <h3>No saved competitive analyses</h3>
              <p>Completed PM Agent competitive analyses will appear here after they are stored.</p>
            </div>
          ) : (
            <div
              className="studio-report-table-wrap studio-panel"
              tabIndex={0}
              role="region"
              aria-label="Saved competitive analyses"
            >
              <table className="studio-report-table">
                <thead>
                  <tr>
                    <th>Analysis ID</th>
                    <th>Created</th>
                    <th>Anchor product</th>
                    <th>Competitors</th>
                    <th>Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {analyses.map((analysis) => (
                    <tr key={analysis.analysisId}>
                      <td>
                        <Link href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}`}>
                          {analysis.analysisId}
                        </Link>
                      </td>
                      <td>{formatPmReportCreatedAt(analysis.createdAt)}</td>
                      <td>{analysis.anchorProduct}</td>
                      <td>{analysis.competitorNames.length}</td>
                      <td>{analysis.sourceCount}</td>
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
