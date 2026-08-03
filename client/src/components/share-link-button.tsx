'use client';

import { useState } from 'react';

interface ShareLinkButtonProps {
  analysisId: string;
}

export function ShareLinkButton({ analysisId }: ShareLinkButtonProps) {
  const [state, setState] = useState<'idle' | 'shared' | 'error'>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const handleCreate = async () => {
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
      setShareUrl(url);
      setState('shared');
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      setState('error');
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

  if (state === 'shared' && shareUrl) {
    return (
      <button type="button" className="studio-button" onClick={handleCopy}>
        Copy share link
      </button>
    );
  }

  return (
    <button type="button" className="studio-button" onClick={handleCreate}>
      Create share link
    </button>
  );
}
