'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Passive pending indicator for a background approval stage (caption or
 * image generation). Polls `router.refresh()` so the server-rendered page
 * advances as soon as the background job flips the post metadata — this also
 * covers landing on a post whose job was started from another session.
 */
export default function GenerationPending({ label }: { label: string }) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    timerRef.current = setInterval(() => router.refresh(), 4000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [router]);

  return (
    <div className="studio-approve" role="status" aria-live="polite">
      <span className="studio-alert">{label}</span>
    </div>
  );
}
