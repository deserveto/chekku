'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { deleteKnowledgeDocument, retryKnowledgeDocumentIngestion } from '@/lib/knowledge';
import type { KnowledgeDocumentView } from '@/lib/knowledge';

const REFRESH_INTERVAL_MS = 4000;
const REFRESH_LIMIT_MS = 5 * 60 * 1000;

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
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const hasPending = documents.some((doc) => doc.status === 'processing');

  useEffect(() => {
    if (!hasPending) return;
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
        if (Array.isArray(payload.documents) && mountedRef.current) {
          setDocuments(payload.documents);
        }
      } catch {
        // Transient polling failure: keep showing the current snapshot.
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  const confirmDelete = useCallback(async () => {
    if (pendingDeleteId === undefined) return;
    setDeleting(true);
    setActionError(undefined);
    const result = await deleteKnowledgeDocument(pendingDeleteId);
    if (!mountedRef.current) return;
    if (!result.ok) {
      setActionError(result.message);
      setDeleting(false);
      setPendingDeleteId(undefined);
      return;
    }
    // Deletion is asynchronous server-side; drop the row optimistically and
    // let polling reconcile if the purge job reports a failure.
    setDocuments((current) => current.filter((doc) => doc.id !== pendingDeleteId));
    setDeleting(false);
    setPendingDeleteId(undefined);
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
                  <span
                    data-knowledge-status={doc.status}
                    title={doc.error ?? STATUS_LABELS[doc.status]}
                  >
                    {STATUS_LABELS[doc.status]}
                    {doc.status === 'failed' && doc.error ? ': ' : ''}
                    {doc.status === 'failed' && doc.error ? doc.error : ''}
                  </span>
                </td>
                <td>{doc.chunkCount ?? '—'}</td>
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
