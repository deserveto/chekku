import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownMessage } from '@/components/markdown-message';
import { ShareLinkButton } from '@/components/share-link-button';
import { ReportTabs } from '@/components/reports/report-tabs';
import {
  CompetitiveAnalysisServiceError,
  getCompetitiveAnalysisForUser,
  getShareTokenForUser,
} from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysisDetailPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const { analysisId } = await params;
  let analysis: Awaited<ReturnType<typeof getCompetitiveAnalysisForUser>> | undefined;
  let errorMessage: string | undefined;
  let initiallyShared = false;

  try {
    analysis = await getCompetitiveAnalysisForUser(analysisId);
    if (analysis.slidesMarkdown && analysis.slidesMarkdown.trim().length > 0) {
      try {
        initiallyShared = (await getShareTokenForUser(analysisId)).shared;
      } catch (error) {
        if (!(error instanceof CompetitiveAnalysisServiceError)) throw error;
      }
    }
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
      <>
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
    </>
    );
  }

  return (
    <>
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Competitive analysis · Market research</p>
            <h1>{analysis.metadata.anchorProduct} competitive landscape</h1>
            <p className="studio-report-id"><code>{analysis.analysisId}</code></p>
            <div className="studio-agent-meta-chips" style={{ margin: '12px 0 0', paddingTop: 0, borderTop: 0 }}>
              <span className="studio-meta-chip"><i className="studio-dot ready" aria-hidden="true" /> {analysis.metadata.competitorNames.length} competitors</span>
              <span className="studio-meta-chip">{analysis.metadata.sourceCount} sources</span>
              <span className="studio-meta-chip">{new Date(analysis.metadata.createdAt).toISOString().slice(0, 10)}</span>
            </div>
          </div>
          <div className="studio-report-header-actions">
            {analysis.slidesMarkdown && analysis.slidesMarkdown.trim().length > 0 ? (
              <>
                <Link
                  className="studio-button"
                  href={`/reports/competitive/${encodeURIComponent(analysis.analysisId)}/slides`}
                >
                  View slides
                </Link>
                <ShareLinkButton
                  analysisId={analysis.analysisId}
                  initiallyShared={initiallyShared}
                />
              </>
            ) : null}
            <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
          </div>
        </header>

        <div className="studio-report-detail-wrap">
          <ReportTabs active="competitive" />
          <div className="studio-report-detail">
          <section className="studio-report-analysis studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Primary document</p>
              <h2>Analysis</h2>
            </div>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={analysis.analysisMarkdown} />
            </div>
          </section>

          <section className="studio-report-context studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Technical context</p>
              <h2>Metadata</h2>
            </div>
            <pre className="studio-report-metadata">
              {JSON.stringify(analysis.metadata, null, 2)}
            </pre>
          </section>

          <section className="studio-report-context studio-panel studio-report-panel">
            <div className="studio-report-section-heading">
              <p className="studio-eyebrow">Source</p>
              <h2>Original request</h2>
            </div>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={analysis.requestMarkdown} />
            </div>
          </section>
          </div>
        </div>
    </>
  );
}
