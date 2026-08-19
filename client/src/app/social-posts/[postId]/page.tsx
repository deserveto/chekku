import Link from 'next/link';
import { notFound } from 'next/navigation';

import ApproveButton from './ApproveButton';
import GenerationPending from './GenerationPending';
import { MarkdownMessage } from '@/components/markdown-message';
import { StudioNav } from '@/components/studio/studio-nav';
import { splitPostMarkdown } from '@/lib/post-markdown';
import { requireUserId } from '@/server/auth';
import {
  getSocialPostForUser,
  SocialPostServiceError,
} from '@/server/social-posts';

export const dynamic = 'force-dynamic';

export default async function SocialPostDetailPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const resourceId = await requireUserId();
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
      <div className="studio-shell">
        <StudioNav resourceId={resourceId} />
        <main className="studio-main">
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
        </main>
      </div>
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

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Social post</p>
            <h1>{post.postId}</h1>
            <p>
              {hasCanonical
                ? 'Canonical content unit, the Instagram caption derived from it after approval, storage metadata, and the brief that generated it.'
                : 'Drafted caption first, followed by storage metadata and the brief that generated it.'}
            </p>
          </div>
          <div className="studio-report-header-actions">
            {status === 'DRAFT' ? (
              <ApproveButton
                postId={post.postId}
                nextStatus="CANONICAL_APPROVED"
                label="Approve Canonical"
              />
            ) : null}
            {status === 'CANONICAL_APPROVED' && !hasCaption ? (
              <GenerationPending label="Generating caption…" />
            ) : null}
            {status === 'CANONICAL_APPROVED' && hasCaption ? (
              <ApproveButton
                postId={post.postId}
                nextStatus="APPROVED"
                label="Approve Caption"
              />
            ) : null}
            {status === 'APPROVED' && !hasVisual ? (
              <GenerationPending label="Generating image…" />
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
      </main>
    </div>
  );
}
