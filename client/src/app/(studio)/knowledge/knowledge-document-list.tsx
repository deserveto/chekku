'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { deleteKnowledgeDocument, retryKnowledgeDocumentIngestion } from '@/lib/knowledge';
import type { KnowledgeDocumentView } from '@/lib/knowledge';

const REFRESH_INTERVAL_MS = 4000;
/** Aligned past the server's 15-minute stale-processing window so a long
 * ingestion keeps transitioning instead of freezing on "Processing". */
const REFRESH_LIMIT_MS = 16 * 60 * 1000;
/** How long a deletion may stay unconfirmed by polling before the row is
 * released back to its stored status with an error. */
const DELETE_CONFIRM_WINDOW_MS = 60_000;

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function kindLabel(mimeType: string, kind: 'text' | 'pdf'): string {
  if (kind === 'pdf') return 'PDF';
  const suffix = mimeType.startsWith('text/') ? mimeType.slice('text/'.length) : '';
  return suffix.length > 0 ? `Text (${suffix})` : 'Text';
}

const STATUS_LABELS: Record<KnowledgeDocumentView['status'], string> = {
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

export function KnowledgeDocumentList({ initialDocuments }: { initialDocuments: KnowledgeDocumentView[] }) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [actionError, setActionError] = useState<string | undefined>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | undefined>();
  /** Docs whose deletion is fired but not yet confirmed by a poll. Their rows
   * stay visible as "Deleting…" — optimistic removal would hide a failed
   * purge forever, because polling only runs while the list is not settled. */
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const deleteStartsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const shouldPoll = documents.some((doc) => doc.status === 'processing') || deletingIds.size > 0;

  useEffect(() => {
    if (!shouldPoll) return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > REFRESH_LIMIT_MS) {
        clearInterval(timer);
        return;
      }
      try {
        const response = await fetch('/api/storage/knowledge/documents');
        if (!response.ok) return;
        const payload = (await response.json()) as { documents?: KnowledgeDocumentView[] };
        if (!Array.isArray(payload.documents) || !mountedRef.current) return;
        setDocuments(payload.documents);
        const serverIds = new Set(payload.documents.map((doc) => doc.id));
        const now = Date.now();
        setDeletingIds((current) => {
          const next = new Set(current);
          for (const id of next) {
            const started = deleteStartsRef.current.get(id) ?? now;
            if (!serverIds.has(id)) {
              // Poll confirmed the purge — row is gone, stop tracking.
              next.delete(id);
              deleteStartsRef.current.delete(id);
            } else if (now - started > DELETE_CONFIRM_WINDOW_MS) {
              // Deletion stalled server-side; release the row so the user
              // sees its stored status and can retry.
              next.delete(id);
              deleteStartsRef.current.delete(id);
              setActionError('Deletion is taking longer than expected. The document is still listed — try deleting it again.');
            }
          }
          return next;
        });
      } catch {
        // Transient polling failure: keep showing the current snapshot.
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll]);

  const confirmDelete = useCallback(async () => {
    if (pendingDeleteId === undefined) return;
    const documentId = pendingDeleteId;
    setDeleting(true);
    setActionError(undefined);
    const result = await deleteKnowledgeDocument(documentId);
    if (!mountedRef.current) return;
    setDeleting(false);
    setPendingDeleteId(undefined);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    // Deletion is asynchronous server-side: keep the row as "Deleting…" and
    // let polling confirm removal. If the purge job fails, the row's stored
    // status becomes visible again instead of silently never coming back.
    deleteStartsRef.current.set(documentId, Date.now());
    setDeletingIds((current) => new Set(current).add(documentId));
  }, [pendingDeleteId]);

  const retry = useCallback(async (documentId: string) => {
    setRetryingId(documentId);
    setActionError(undefined);
    const result = await retryKnowledgeDocumentIngestion(documentId);
    if (!mountedRef.current) return;
    if (!result.ok) {
      setActionError(result.message);
    } else {
      setDocuments((current) => current.map((doc) => (
        doc.id === documentId
          ? { ...doc, status: 'processing' as const, error: undefined }
          : doc
      )));
    }
    setRetryingId(undefined);
  }, []);

  if (documents.length === 0) {
    return (
      <section className="studio-section">
        <div className="studio-empty-state">
          <h3>No documents in your Knowledge yet.</h3>
          <p>
            Supported documents you upload in chat — text files and PDFs — are saved here
            automatically and become searchable for your agents.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="studio-section">
      {actionError ? (
        <div className="studio-alert studio-alert-error" role="alert">
          {actionError}
        </div>
      ) : null}
      <div
        className="studio-report-table-wrap studio-panel"
        tabIndex={0}
        role="region"
        aria-label="Knowledge documents"
      >
        <table className="studio-report-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>Status</th>
              <th>Indexed chunks</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.filename}</td>
                <td>{kindLabel(doc.mimeType, doc.kind)}</td>
                <td>{formatBytes(doc.sizeBytes)}</td>
                <td>{formatUploadedAt(doc.createdAt)}</td>
                <td>
                  {deletingIds.has(doc.id) ? (
                    <span data-knowledge-status="deleting">Deleting…</span>
                  ) : (
                    <span
                      data-knowledge-status={doc.status}
                      title={doc.error ?? STATUS_LABELS[doc.status]}
                    >
                      {STATUS_LABELS[doc.status]}
                      {doc.status === 'failed' && doc.error ? ': ' : ''}
                      {doc.status === 'failed' && doc.error ? doc.error : ''}
                    </span>
                  )}
                </td>
                <td>
                  {doc.chunkCount ?? '—'}
                </td>
                <td>
                  <div className="studio-action-row">
                    <a href={`/api/storage/knowledge/documents/${encodeURIComponent(doc.id)}/original`}>
                      Open
                    </a>
                    {doc.status === 'failed' || doc.status === 'processing' ? (
                      <button
                        type="button"
                        className="studio-button"
                        disabled={retryingId === doc.id || (doc.status === 'processing' && !isStaleProcessing(doc))}
                        onClick={() => void retry(doc.id)}
                      >
                        {retryingId === doc.id ? 'Retrying…' : 'Retry indexing'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="studio-button"
                      disabled={deletingIds.has(doc.id)}
                      onClick={() => setPendingDeleteId(doc.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmationDialog
        open={pendingDeleteId !== undefined}
        title="Delete from Knowledge?"
        description={
          pendingDeleteId === undefined
            ? ''
            : `"${documents.find((doc) => doc.id === pendingDeleteId)?.filename ?? pendingDeleteId}" will be removed from your Knowledge. Agents will no longer find its content.`
        }
        confirmLabel="Delete"
        pending={deleting}
        onCancel={() => setPendingDeleteId(undefined)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}

/** A processing run only becomes retryable after the stale window; mirror the server rule. */
function isStaleProcessing(doc: KnowledgeDocumentView): boolean {
  if (doc.status !== 'processing') return false;
  const updatedAtMs = Date.parse(doc.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  return Date.now() - updatedAtMs >= 15 * 60 * 1000;
}
