'use client';

import { useRef, useState } from 'react';

interface ShareLinkButtonProps {
  analysisId: string;
  initiallyShared?: boolean;
}

export function ShareLinkButton({ analysisId, initiallyShared = false }: ShareLinkButtonProps) {
  const [state, setState] = useState<'idle' | 'pending' | 'shared' | 'error'>(
    initiallyShared ? 'shared' : 'idle',
  );
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const isCreatingRef = useRef(false);

  const handleCreate = async () => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
    setState('pending');
    try {
      const response = await fetch(
        `/api/storage/competitive-analyses/${encodeURIComponent(analysisId)}/share`,
        { method: 'POST' },
      );
      if (!response.ok) {
        setState('error');
        return;
      }
      const { url } = (await response.json()) as { url: string };
      const absoluteUrl = `${window.location.origin}${url}`;
      setShareUrl(absoluteUrl);
      setState('shared');
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(absoluteUrl);
      }
    } catch {
      setState('error');
    } finally {
      isCreatingRef.current = false;
    }
  };

  const handleCopy = async () => {
    if (!shareUrl || !navigator.clipboard) return;
    await navigator.clipboard.writeText(shareUrl);
  };

  if (state === 'error') {
    return (
      <div className="studio-share-button-group">
        <button type="button" className="studio-button" onClick={handleCreate}>
          Create share link
        </button>
        <span className="studio-share-button-error" role="alert">
          Could not create share link
        </span>
      </div>
    );
  }

  if (state === 'shared') {
    return (
      <button
        type="button"
        className="studio-button"
        onClick={shareUrl ? handleCopy : handleCreate}
      >
        Copy share link
      </button>
    );
  }

  if (state === 'pending') {
    return (
      <button type="button" className="studio-button" disabled>
        Creating share link...
      </button>
    );
  }

  return (
    <button type="button" className="studio-button" onClick={handleCreate}>
      Create share link
    </button>
  );
}
