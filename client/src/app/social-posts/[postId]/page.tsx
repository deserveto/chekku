import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownMessage } from '@/components/markdown-message';
import { StudioNav } from '@/components/studio/studio-nav';
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
  const resourceId = process.env.CHEKKU_LOCAL_USER_ID || 'local-user';
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

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header studio-report-header">
          <div>
            <p className="studio-eyebrow">Social post</p>
            <h1>{post.postId}</h1>
            <p>Drafted caption first, followed by storage metadata and the brief that generated it.</p>
          </div>
          <Link className="studio-button" href="/social-posts">Back to social posts</Link>
        </header>

        <div className="studio-report-detail">
          <section className="studio-panel studio-report-panel">
            <h2 className="studio-eyebrow">Caption</h2>
            <div className="studio-report-markdown markdown">
              <MarkdownMessage content={post.postMarkdown} />
            </div>
          </section>

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
