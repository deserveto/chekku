'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Dev-only button that manually triggers the `weekly-social-drafts` workflow
 * on demand (fire-and-forget). Rendered only outside production.
 */
export default function RunWeeklyDraftsButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function handleRun() {
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const res = await fetch('/api/storage/social-posts/run-weekly-drafts', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not start the workflow.');
      }
      setMessage('Started — refresh in a few moments to see new drafts.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the workflow.');
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <div className="studio-run-weekly">
      <button type="button" disabled={pending} onClick={() => void handleRun()}>
        {pending ? 'Starting…' : 'Run weekly drafts now'}
      </button>
      {message ? <span className="studio-run-weekly-note">{message}</span> : null}
      {error ? (
        <span className="studio-run-weekly-error" role="alert">{error}</span>
      ) : null}
    </div>
  );
}
