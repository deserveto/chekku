import Link from 'next/link';

import { StudioNav } from '@/components/studio/studio-nav';
import { ReportTabs } from '@/components/reports/report-tabs';
import { requireUserId } from '@/server/auth';
import {
  CompetitiveAnalysisServiceError,
  listCompetitiveAnalysesForUser,
} from '@/server/competitive-analyses';
import { formatPmReportCreatedAt } from '@/server/pm-report-format';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysesPage() {
  const resourceId = await requireUserId();
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
        </header>

        <section className="studio-section">
          <ReportTabs active="competitive" />
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
              className="studio-report-grid"
              role="list"
              aria-label="Saved competitive analyses"
            >
              {analyses.map((analysis) => (
                <article className="studio-report-card" role="listitem" key={analysis.analysisId}>
                  <div className="studio-agent-card-top">
                    <span className="studio-agent-glyph" aria-hidden="true">◎</span>
                    <span className="studio-source-badge">Market</span>
                  </div>

                  <div>
                    <h3>{analysis.anchorProduct}</h3>
                    <code>{analysis.analysisId}</code>
                  </div>

                  <dl className="studio-agent-meta">
                    <div>
                      <dt>Created</dt>
                      <dd>{formatPmReportCreatedAt(analysis.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Competitors</dt>
                      <dd>{analysis.competitorNames.length}</dd>
                    </div>
                    <div>
                      <dt>Sources</dt>
                      <dd>{analysis.sourceCount}</dd>
                    </div>
                  </dl>

                  <div className="studio-card-actions">
                    <Link
                      className="studio-button studio-button-primary"
                      href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}`}
                    >
                      View analysis
                    </Link>
                    <Link
                      className="studio-button"
                      href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
                    >
                      Slides
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
