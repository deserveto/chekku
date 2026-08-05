import { notFound } from 'next/navigation';

import { CompetitiveSlides } from '@/components/competitive-slides';
import { getPublicSlides } from '@/server/competitive-analyses';

export const dynamic = 'force-dynamic';

export default async function PublicSlidesPage({
  params,
  searchParams,
}: {
  params: Promise<{ analysisId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { analysisId } = await params;
  const { t } = await searchParams;
  const token = typeof t === 'string' ? t : undefined;

  if (!token) {
    notFound();
  }

  let payload: Awaited<ReturnType<typeof getPublicSlides>>;
  try {
    payload = await getPublicSlides(analysisId, token!);
  } catch {
    // All errors (not-found, storage-unavailable, internal) collapse to 404 to avoid
    // revealing whether an analysis exists. Storage outages on the public route should
    // be rare; the cost of leaking existence is higher than the cost of a 404.
    notFound();
  }

  return (
    <div className="public-slides-shell">
      <main className="public-slides-main">
        <CompetitiveSlides
          variant="public"
          analysisId={payload.analysisId}
          slidesMarkdown={payload.slidesMarkdown}
          anchorProduct={payload.anchorProduct}
          createdAt={payload.createdAt}
        />
      </main>
    </div>
  );
}
