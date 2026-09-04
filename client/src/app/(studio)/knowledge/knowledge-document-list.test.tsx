// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { KnowledgeDocumentList } from './knowledge-document-list';
import type { KnowledgeDocumentView } from '@/lib/knowledge';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    (this as HTMLDialogElement).open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    (this as HTMLDialogElement).open = false;
  };
});

let root: Root | null = null;
function render(ui: ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => { r.render(ui); });
  return container;
}
afterEach(() => {
  act(() => { root?.unmount(); });
  document.body.innerHTML = '';
  root = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const doc = (overrides: Partial<KnowledgeDocumentView> = {}): KnowledgeDocumentView => ({
  id: 'kbd_20260828120000_deadbeef',
  filename: 'handbook.pdf',
  mimeType: 'application/pdf',
  kind: 'pdf',
  sizeBytes: 2048,
  status: 'ready',
  chunkCount: 12,
  createdAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
  ...overrides,
});

describe('KnowledgeDocumentList', () => {
  it('shows the empty state when no documents exist', () => {
    const container = render(<KnowledgeDocumentList initialDocuments={[]} />);
    expect(container.textContent).toContain('No documents in your Knowledge yet.');
    expect(container.textContent).toContain('upload in chat');
  });

  it('lists documents with filename, type, size, date, status, and chunk count', () => {
    const container = render(
      <KnowledgeDocumentList
        initialDocuments={[
          doc(),
          doc({
            id: 'kbd_20260828120001_cafe0001',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            kind: 'text',
            sizeBytes: 512,
            status: 'processing',
            chunkCount: undefined,
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain('handbook.pdf');
    expect(container.textContent).toContain('notes.txt');
    expect(container.textContent).toContain('PDF');
    expect(container.textContent).toContain('2.0 KB');
    expect(container.textContent).toContain('Ready');
    expect(container.textContent).toContain('Processing');
    expect(container.textContent).toContain('12');
  });

  it('surfaces the failure reason for failed documents', () => {
    const container = render(
      <KnowledgeDocumentList
        initialDocuments={[doc({ status: 'failed', error: 'No extractable text found in this document.' })]}
      />,
    );
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).toContain('No extractable text found');
    // Retry is offered for failed documents.
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toContain('Retry indexing');
  });

  it('does not offer retry for ready documents', () => {
    const container = render(<KnowledgeDocumentList initialDocuments={[doc()]} />);
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).not.toContain('Retry indexing');
    expect(buttons).toContain('Delete');
  });

  it('links the Open action to the authenticated original-bytes route', () => {
    const container = render(<KnowledgeDocumentList initialDocuments={[doc()]} />);
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Open');
    expect(link?.getAttribute('href')).toBe(
      '/api/storage/knowledge/documents/kbd_20260828120000_deadbeef/original',
    );
  });

  it('keeps the row as Deleting… until a poll confirms removal', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/documents')) {
        // Poll response: the purge has completed, the record is gone.
        return { ok: true, json: async () => ({ documents: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    const container = render(<KnowledgeDocumentList initialDocuments={[doc()]} />);

    const deleteButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete') as HTMLButtonElement;
    await act(async () => { deleteButton.click(); });

    const dialog = container.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain('Delete from Knowledge?');

    const confirmButton = [...dialog!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete') as HTMLButtonElement;
    await act(async () => { confirmButton.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/storage/knowledge/documents/kbd_20260828120000_deadbeef',
      { method: 'DELETE' },
    );
    // Optimistic removal would hide a failed purge: the row stays visible
    // as Deleting… until a poll confirms the record is gone.
    expect(container.textContent).toContain('handbook.pdf');
    expect(container.querySelector('[data-knowledge-status="deleting"]')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    expect(container.textContent).toContain('No documents in your Knowledge yet.');
  });

  it('shows an action error banner when deletion fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: { code: 'workflow-trigger-failed', message: 'Deletion could not be started. Try again.' } }),
    } as Response);
    const container = render(<KnowledgeDocumentList initialDocuments={[doc()]} />);

    const deleteButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete') as HTMLButtonElement;
    await act(async () => { deleteButton.click(); });
    const dialog = container.querySelector('dialog');
    const confirmButton = [...dialog!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete') as HTMLButtonElement;
    await act(async () => { confirmButton.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Deletion could not be started');
    // The document stays visible for a retry.
    expect(container.textContent).toContain('handbook.pdf');
  });

  it('retries failed documents through the retry endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    const container = render(
      <KnowledgeDocumentList initialDocuments={[doc({ status: 'failed', error: 'boom' })]} />,
    );

    const retryButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retry indexing') as HTMLButtonElement;
    await act(async () => { retryButton.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/storage/knowledge/documents/kbd_20260828120000_deadbeef/retry',
      { method: 'POST' },
    );
    expect(container.querySelector('[data-knowledge-status="processing"]')).toBeTruthy();
  });
});
