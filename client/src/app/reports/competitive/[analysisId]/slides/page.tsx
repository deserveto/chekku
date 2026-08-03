import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CompetitiveSlides } from '@/components/competitive-slides';
import { StudioNav } from '@/components/studio/studio-nav';
import { requireUserId } from '@/server/auth';
import {
  CompetitiveAnalysisServiceError,
  getCompetitiveAnalysisForUser,
} from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function CompetitiveAnalysisSlidesPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const resourceId = await requireUserId();
  const { analysisId } = await params;
  let slidesMarkdown: string | undefined;
  let errorMessage: string | undefined;

  try {
    const analysis = await getCompetitiveAnalysisForUser(analysisId);
    slidesMarkdown = analysis.slidesMarkdown;
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

  if (!errorMessage && (!slidesMarkdown || slidesMarkdown.trim().length === 0)) {
    notFound();
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Competitive analysis slides</p>
            <h1>{analysisId}</h1>
            <p>Rendered Marp deck built from the saved analysis.</p>
          </div>
          <Link className="studio-button" href={`/reports/competitive/${encodeURIComponent(analysisId)}`}>
            Back to analysis
          </Link>
        </header>

        <section className="studio-section">
          {errorMessage ? (
            <div className="studio-alert studio-alert-error" role="alert">
              <p>Slides unavailable</p>
              <p>{errorMessage}</p>
            </div>
          ) : slidesMarkdown ? (
            <CompetitiveSlides analysisId={analysisId} slidesMarkdown={slidesMarkdown} />
          ) : null}
        </section>
      </main>
    </div>
  );
}
