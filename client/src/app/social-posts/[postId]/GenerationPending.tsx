'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 4000;
/**
 * Polling is bounded: a background job that has not advanced the post within
 * this budget is treated as failed or stuck, so the indicator stops instead
 * of polling forever over a dead job (the user gets recovery guidance).
 */
const POLL_BUDGET_MS = 300_000;

/**
 * Passive pending indicator for a background approval stage (caption or
 * image generation). Polls `router.refresh()` so the server-rendered page
 * advances as soon as the background job flips the post metadata — this also
 * covers landing on a post whose job was started from another session.
 * When the budget runs out, the pending label is replaced by the caller's
 * `timeoutMessage` and polling stops.
 */
export default function GenerationPending({
  label,
  timeoutMessage,
}: {
  label: string;
  timeoutMessage: string;
}) {
  const router = useRouter();
  // Latest-ref so the poll lifecycle (interval + budget) is created exactly
  // once per mount and never restarts with a fresh budget on a router
  // identity change; the ref is synced inside an effect, never during render.
  const routerRef = useRef(router);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      if (Date.now() - startedAt >= POLL_BUDGET_MS) {
        if (timerRef.current) clearInterval(timerRef.current);
        setTimedOut(true);
        return;
      }
      routerRef.current.refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  if (timedOut) {
    return (
      <div className="studio-approve" role="alert">
        <span className="studio-alert studio-alert-error">{timeoutMessage}</span>
      </div>
    );
  }

  return (
    <div className="studio-approve" role="status" aria-live="polite">
      <span className="studio-alert">{label}</span>
    </div>
  );
}
