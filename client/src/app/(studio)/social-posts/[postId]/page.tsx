import Link from 'next/link';
import { notFound } from 'next/navigation';

import ApproveButton from './ApproveButton';
import GenerationPending from './GenerationPending';
import { MarkdownMessage } from '@/components/markdown-message';
import { splitPostMarkdown } from '@/lib/post-markdown';
import {
  getSocialPostForUser,
  SocialPostServiceError,
} from '@/server/social-posts';

export const dynamic = 'force-dynamic';

/** How long after caption approval a background visual is still plausibly running. */
export const VISUAL_PENDING_WINDOW_MS = 10 * 60_000;

/**
 * A visual is only plausibly "generating" while the caption approval that
 * triggered it is recent. Legacy APPROVED posts (approved under the old
 * direct DRAFT→APPROVED flow, so no `captionApprovedAt`) and posts whose
 * generation window has long passed show a neutral hint instead of an
 * endless pending spinner. Pure predicate with an injectable clock.
 */
export function isVisualGenerationPlausible(
  captionApprovedAt: string | undefined,
  nowMs: () => number = Date.now,
  windowMs: number = VISUAL_PENDING_WINDOW_MS,
): boolean {
  if (!captionApprovedAt) return false;
  const approvedAtMs = Date.parse(captionApprovedAt);
  return Number.isFinite(approvedAtMs) && nowMs() - approvedAtMs <= windowMs;
}

export default async function SocialPostDetailPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  let post: Awaited<ReturnType<typeof getSocialPostForUser>> | undefined;
  let errorMessage: string | undefined;

  try {
    post = await getSocialPostForUser(postId);
  } catch (error) {
    if (
      error instanceof SocialPostServiceError
      && (error.code === 'invalid-post-id' || error.code === 'not-found')
    ) {
      notFound();
    }
    errorMessage = error instanceof SocialPostServiceError
      ? error.message
      : 'Could not load social post.';
  }

  if (!post) {
    return (
      <>
          <header className="studio-page-header">
            <div>
              <p className="studio-eyebrow">Social post</p>
              <h1>Draft unavailable</h1>
            </div>
            <Link className="studio-button" href="/social-posts">Back to social posts</Link>
          </header>
          <section className="studio-section">
            <div className="studio-alert studio-alert-error" role="alert">
              {errorMessage ?? 'Could not load social post.'}
            </div>
          </section>
    </>
    );
  }

  const { canonicalMarkdown, captionMarkdown: embeddedCaption } = splitPostMarkdown(post.postMarkdown);
  const hasCanonical = Boolean(canonicalMarkdown);
  // Caption stage output lives in caption.md once the post reached
  // CANONICAL_APPROVED; legacy posts embed the caption inside post.md.
  const captionMarkdown = post.captionMarkdown ?? embeddedCaption;
  const hasCaption = Boolean(captionMarkdown && captionMarkdown.trim().length > 0);
  const activeVisual = post.metadata.activeVisualAssetId
    ? post.metadata.visualAssets?.find((asset) => asset.assetId === post.metadata.activeVisualAssetId)
    : undefined;
  const hasVisual = (post.metadata.visualAssets?.length ?? 0) > 0;
  const status = post.metadata.status;

  // A visual is only plausibly "generating" while the caption approval that
  // triggered it is recent — see `isVisualGenerationPlausible` above.
  const visualGenerationPlausible = isVisualGenerationPlausible(post.metadata.captionApprovedAt);

  function badgeClassForSocialStatus(raw: string): string {
    if (raw === 'DRAFT') return 'status-draft';
    if (raw === 'CANONICAL_APPROVED') return 'status-canonical';
    if (raw === 'APPROVED') return 'status-approved';
    if (raw === 'PUBLISHED') return 'status-published';
    return '';
  }

  return (
    <>
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Social post · Instagram draft</p>
            <h1>{post.postId}</h1>
            <p>
              {hasCanonical
                ? 'Canonical content unit, the Instagram caption derived from it after approval, storage metadata, and the brief that generated it.'
                : 'Drafted caption first, followed by storage metadata and the brief that generated it.'}
            </p>
            <div className="studio-agent-meta-chips" style={{ margin: '12px 0 0', paddingTop: 0, borderTop: 0 }}>
              <span className={`studio-source-badge ${badgeClassForSocialStatus(status)}`}>{status.replace('_', ' ')}</span>
              <span className="studio-meta-chip">{post.metadata.topic}</span>
              {post.metadata.specialDay ? <span className="studio-meta-chip">{post.metadata.specialDay}</span> : null}
              <span className="studio-meta-chip">{new Date(post.metadata.createdAt).toISOString().slice(0, 10)}</span>
            </div>
          </div>
          <div className="studio-report-header-actions">
            {status === 'DRAFT' && hasCanonical ? (
              <ApproveButton
                postId={post.postId}
                nextStatus="CANONICAL_APPROVED"
                label="Approve Canonical"
              />
            ) : null}
            {status === 'DRAFT' && !hasCanonical ? (
              // Legacy caption-only draft (pre-canonical contract): the
              // caption stage can never run for it (the repurpose workflow
              // rejects it with `canonical-missing`), so offer no approve
              // action — only an explanatory notice.
              <div className="studio-approve">
                <span className="studio-alert">Legacy draft without a canonical content unit — it cannot enter the two-stage approval flow.</span>
              </div>
            ) : null}
            {status === 'CANONICAL_APPROVED' && !hasCaption ? (
              <GenerationPending
                label="Generating caption…"
                timeoutMessage="Caption generation is taking longer than expected. It may have failed — reload to check the latest status, or approve the canonical content again to retry."
              />
            ) : null}
            {status === 'CANONICAL_APPROVED' && hasCaption ? (
              <ApproveButton
                postId={post.postId}
                nextStatus="APPROVED"
                label="Approve Caption"
              />
            ) : null}
            {status === 'APPROVED' && !hasVisual ? (
              visualGenerationPlausible ? (
                <GenerationPending
                  label="Generating image…"
                  timeoutMessage="Image generation is taking longer than expected. It may have failed — reload to check the latest status. If the visual stays missing, request it again through the supervisor chat."
                />
              ) : (
                <div className="studio-approve">
                  <span className="studio-alert">No visual yet — request generation through the supervisor chat.</span>
                </div>
              )
            ) : null}
            <Link className="studio-button" href="/social-posts">Back to social posts</Link>
          </div>
        </header>

        <div className="studio-report-detail">
          {hasCanonical && (
            <section className="studio-panel studio-report-panel">
              <h2 className="studio-eyebrow">Canonical Content Unit</h2>
              <div className="studio-report-markdown markdown">
                <MarkdownMessage content={canonicalMarkdown!} />
              </div>
            </section>
          )}

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">{hasCanonical ? 'Instagram Caption' : 'Caption'}</h2>
            <div className="studio-report-markdown markdown">
              {hasCaption ? (
                <MarkdownMessage content={captionMarkdown} />
              ) : status === 'DRAFT' ? (
                <p className="studio-muted">
                  The caption is generated after the canonical content is approved.
                </p>
              ) : (
                <p className="studio-muted">Generating caption…</p>
              )}
            </div>
          </section>

          {activeVisual ? (
            <section className="studio-panel studio-report-panel">
              <h2 className="studio-eyebrow">Visual</h2>
              <figure className="studio-visual">
                {/* Image is served from the same-origin dynamic storage route
                    and is already a bounded binary, so next/image optimization
                    does not apply here. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="studio-visual-image"
                  src={activeVisual.imageUrl}
                  alt={`Generated visual ${activeVisual.assetId} for ${post.postId}`}
                  loading="lazy"
                />
                <figcaption className="studio-visual-meta">
                  <code>{activeVisual.assetId}</code>
                  {' '}
                  <span>{activeVisual.mimeType}</span>
                  {' '}
                  <span>{activeVisual.model}</span>
                </figcaption>
              </figure>
            </section>
          ) : null}

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Metadata</h2>
            <pre className="studio-report-metadata">
              {JSON.stringify(post.metadata, null, 2)}
            </pre>
          </section>

          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Brief</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={post.briefMarkdown} />
            </div>
          </section>
        </div>
    </>
  );
}
