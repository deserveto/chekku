import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownMessage } from '@/components/markdown-message';
import { StudioNav } from '@/components/studio/studio-nav';
import { requireUserId } from '@/server/auth';
import {
  CompetitiveAnalysisServiceError,
  getCompetitiveAnalysisForUser,
} from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysisDetailPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const resourceId = await requireUserId();
  const { analysisId } = await params;
  let analysis: Awaited<ReturnType<typeof getCompetitiveAnalysisForUser>> | undefined;
  let errorMessage: string | undefined;

  try {
    analysis = await getCompetitiveAnalysisForUser(analysisId);
  } catch (error) {
    if (
      error instanceof CompetitiveAnalysisServiceError
      && (error.code === 'invalid-analysis-id' || error.code === 'not-found')
    ) {
      notFound();
    }
    errorMessage = error instanceof CompetitiveAnalysisServiceError
      ? error.message
      : 'Could not load competitive analysis.';
  }

  if (!analysis) {
    return (
      <div className="studio-shell">
        <StudioNav resourceId={resourceId} />
        <main className="studio-main">
          <header className="studio-page-header">
            <div>
              <p className="studio-eyebrow">Competitive analysis</p>
              <h1>Competitive analysis unavailable</h1>
            </div>
            <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
          </header>
          <section className="studio-section">
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage ?? 'Could not load competitive analysis.'}
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
            <p className="studio-eyebrow">Competitive analysis</p>
            <h1>{analysis.analysisId}</h1>
            <p>Saved analysis first, followed by storage metadata and original request.</p>
          </div>
          <div className="studio-report-header-actions">
            {analysis.slidesMarkdown && analysis.slidesMarkdown.trim().length > 0 ? (
              <Link
                className="studio-button"
                href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
              >
                View slides
              </Link>
            ) : null}
            <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
          </div>
        </header>

        <div className="studio-report-detail">
          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Analysis</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={analysis.analysisMarkdown} />
            </div>
          </section>

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Metadata</h2>
            <pre className="studio-report-metadata">
              {JSON.stringify(analysis.metadata, null, 2)}
            </pre>
          </section>

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Original request</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={analysis.requestMarkdown} />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
