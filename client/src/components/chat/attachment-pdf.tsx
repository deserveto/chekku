'use client';

import { useEffect, useId, useRef } from 'react';

/**
 * Compact PDF attachment card for the chat timeline. A live send only has a
 * cover data URL and opens once the Knowledge upload exists (documentId);
 * a restored group has page images and always opens. Disabled cards explain
 * when the original becomes openable.
 */
export function PdfAttachmentCard({
  filename,
  pageCount,
  byteSize,
  coverUrl,
  canOpen,
  onOpen,
}: {
  filename: string;
  pageCount: number;
  byteSize?: number;
  coverUrl?: string;
  canOpen: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="chat-pdf-card"
      onClick={onOpen}
      disabled={!canOpen}
      aria-label={`Open PDF preview: ${filename}`}
      title={canOpen ? undefined : 'The original PDF opens once the upload finishes.'}
    >
      {coverUrl ? (
        // Data-URL thumbnails cannot use next/image without
        // per-origin configuration; a plain img is correct here.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="chat-pdf-card-cover" src={coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="chat-pdf-card-cover chat-pdf-card-cover-empty" aria-hidden="true">
          ⎘
        </span>
      )}
      <span className="chat-pdf-card-meta">
        <span className="chat-pdf-card-name">{filename}</span>
        <span className="chat-pdf-card-sub">
          PDF · {pageCount} page{pageCount === 1 ? '' : 's'}
          {typeof byteSize === 'number' ? ` · ${formatPdfBytes(byteSize)}` : ''}
        </span>
      </span>
    </button>
  );
}

function formatPdfBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Same-origin PDF viewer. With a `documentId` the AUTHENTICATED original
 * route serves the real PDF inline (works while indexing AND after failure —
 * the raw document is durable from the upload POST on); restored groups fall
 * back to their grouped page images.
 */
export function PdfViewerDialog({
  open,
  filename,
  pageCount,
  documentId,
  pages,
  onClose,
}: {
  open: boolean;
  filename: string;
  pageCount: number;
  documentId?: string;
  pages?: string[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!wasOpenRef.current) {
        restoreFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }
      if (!dialog.open) dialog.showModal();
      wasOpenRef.current = true;
      return;
    }

    if (dialog.open) dialog.close();
    if (wasOpenRef.current) {
      restoreFocusRef.current?.focus();
    }
    wasOpenRef.current = false;
  }, [open]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    if (wasOpenRef.current) {
      restoreFocusRef.current?.focus();
    }
    wasOpenRef.current = false;
  }, []);

  const originalSrc = documentId
    ? `/api/storage/knowledge/documents/${encodeURIComponent(documentId)}/original`
    : undefined;

  return (
    <dialog
      ref={dialogRef}
      className="chat-pdf-viewer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Native Escape path: prevent the implicit close so React state
        // stays the single source of truth, then route through onClose.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicks on the ::backdrop land on the dialog element itself; a
        // sidebar click on the content never matches the dialog target.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <header className="chat-pdf-viewer-header">
        <h2 id={titleId} className="chat-pdf-viewer-title">
          {filename}
          <small>
            {' '}
            · {pageCount} page{pageCount === 1 ? '' : 's'}
          </small>
        </h2>
        <button
          type="button"
          className="chat-pdf-viewer-close"
          onClick={onClose}
          aria-label="Close PDF preview"
        >
          ✕
        </button>
      </header>
      <div className="chat-pdf-viewer-body">
        {originalSrc ? (
          <iframe src={originalSrc} title={filename} className="chat-pdf-frame" />
        ) : pages && pages.length > 0 ? (
          <div className="chat-pdf-pages" role="list">
            {pages.map((src, index) => (
              <figure key={index} role="listitem" className="chat-pdf-page">
                {/* Data-URL page images; same rationale as the card cover. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={`${filename} — page ${index + 1} of ${pages.length}`}
                  loading="lazy"
                />
                <figcaption>
                  page {index + 1} of {pages.length}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
