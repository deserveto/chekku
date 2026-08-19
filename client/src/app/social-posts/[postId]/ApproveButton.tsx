'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Stage-aware approval button (2-stage approval, per Pembahasan 2).
 *
 * `CANONICAL_APPROVED` approves the canonical content of a DRAFT post and
 * starts background caption generation; `APPROVED` approves the caption of a
 * CANONICAL_APPROVED post and starts background visual generation. The
 * backend performs the actual status transition inside the background job,
 * so after a successful PATCH the button keeps refreshing the page until the
 * server-rendered stage advances (which unmounts it).
 */
export type ApprovalStage = 'CANONICAL_APPROVED' | 'APPROVED';

export default function ApproveButton({
  postId,
  nextStatus,
  label,
}: {
  postId: string;
  nextStatus: ApprovalStage;
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  function beginPolling() {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => router.refresh(), 4000);
  }

  async function handleApprove() {
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/storage/social-posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not approve post.');
      }
      // The background job performs the transition; poll until the
      // server-rendered stage advances past this button.
      beginPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve post.');
      setPending(false);
    }
  }

  const workingLabel = nextStatus === 'CANONICAL_APPROVED'
    ? 'Generating caption…'
    : 'Generating image…';

  return (
    <div className="studio-approve">
      <button
        className="studio-button"
        type="button"
        onClick={handleApprove}
        disabled={pending}
      >
        {pending ? workingLabel : label}
      </button>
      {error ? (
        <span className="studio-alert studio-alert-error" role="alert">{error}</span>
      ) : null}
    </div>
  );
}
