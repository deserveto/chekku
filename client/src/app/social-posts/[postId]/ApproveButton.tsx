'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 4000;
/**
 * Polling is bounded: if the background job has not advanced the stage within
 * this budget, the button stops polling, re-enables, and surfaces recovery
 * guidance — a failed caption job leaves the post DRAFT (approve again) and
 * the page never polls forever.
 */
const POLL_BUDGET_MS = 300_000;

const TIMEOUT_MESSAGE = 'This is taking longer than expected. The background job may still be running or may have failed — reload to see the latest status, or try approving again.';

/**
 * Stage-aware approval button (2-stage approval, per Pembahasan 2).
 *
 * `CANONICAL_APPROVED` approves the canonical content of a DRAFT post and
 * starts background caption generation; `APPROVED` approves the caption of a
 * CANONICAL_APPROVED post and starts background visual generation. The
 * backend performs the actual status transition inside the background job,
 * so after a successful PATCH the button keeps refreshing the page until the
 * server-rendered stage advances (which unmounts it) or the poll budget
 * runs out (which re-enables the button with recovery guidance).
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
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function beginPolling() {
    if (timerRef.current) return;
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      if (Date.now() - startedAt >= POLL_BUDGET_MS) {
        stopPolling();
        setTimedOut(true);
        setPending(false);
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);
  }

  async function handleApprove() {
    setPending(true);
    setTimedOut(false);
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
      {timedOut ? (
        <span className="studio-alert studio-alert-error" role="alert">{TIMEOUT_MESSAGE}</span>
      ) : null}
      {error ? (
        <span className="studio-alert studio-alert-error" role="alert">{error}</span>
      ) : null}
    </div>
  );
}
