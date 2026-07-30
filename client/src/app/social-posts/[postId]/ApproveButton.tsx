'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ApproveButton({ postId }: { postId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleApprove() {
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/storage/social-posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not approve post.');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve post.');
      setPending(false);
    }
  }

  return (
    <div className="studio-approve">
      <button
        className="studio-button"
        type="button"
        onClick={handleApprove}
        disabled={pending}
      >
        {pending ? 'Approving…' : 'Approve'}
      </button>
      {error ? (
        <span className="studio-alert studio-alert-error" role="alert">{error}</span>
      ) : null}
    </div>
  );
}
