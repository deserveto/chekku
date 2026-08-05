import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CompetitiveSlides } from '@/components/competitive-slides';
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
  // The deck renders full-bleed without StudioNav, so this call is only the auth
  // gate: unauthenticated visitors redirect to /login instead of reaching slides.
  await requireUserId();
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

  if (errorMessage) {
    return (
      <div className="competitive-slides-page competitive-slides-page-error">
        <div className="competitive-slides-page-back">
          <Link className="studio-button" href="/reports/competitive">Back to analyses</Link>
        </div>
        <div className="studio-alert studio-alert-error" role="alert">
          <p>Slides unavailable</p>
          <p>{errorMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="competitive-slides-page">
      <div className="competitive-slides-page-back">
        <Link className="studio-button" href={`/reports/competitive/${encodeURIComponent(analysisId)}`}>
          ← Back to analysis
        </Link>
      </div>
      <CompetitiveSlides analysisId={analysisId} slidesMarkdown={slidesMarkdown!} />
    </div>
  );
}
