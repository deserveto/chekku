/**
 * Shared Knowledge Base client helpers.
 *
 * Pure, environment-agnostic (no 'use client', no server-only): imported by
 * the chat composer (to decide which attachments are Knowledge-eligible), by
 * the upload/fire-and-forget path, and by the Next.js server service for the
 * identical validation contract. Image files are deliberately unsupported —
 * they stay in the multimodal chat path and are never OCR-ed.
 */

const KNOWLEDGE_TEXT_EXTENSION_ALLOWED: Record<string, true> = {
  txt: true,
  md: true,
  csv: true,
  tsv: true,
  json: true,
  log: true,
  xml: true,
  yml: true,
  yaml: true,
};

/**
 * Raw-binary caps for persisted Knowledge documents (chat inline caps are
 * separate). The 16 MiB PDF cap MUST stay ≤ the Garage adapter's
 * `MAX_BINARY_BODY_BYTES` (storage/src/garage.ts) — a larger upload would
 * persist and then fail every ingestion read, permanently stuck. The
 * production nginx `client_max_body_size` (ops/nginx/chekku.conf) must stay
 * above the larger of these caps plus multipart overhead.
 */
export const MAX_KNOWLEDGE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_KNOWLEDGE_PDF_BYTES = 16 * 1024 * 1024;

export type KnowledgeFileKind = 'text' | 'pdf';

export type KnowledgeClassification = KnowledgeFileKind | 'unsupported';

/** Same contract for browser and server: classify by MIME first, extension second. */
export function classifyKnowledgeFile(input: { name: string; type: string }): KnowledgeClassification {
  const name = input.name.toLowerCase();
  if (input.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (input.type.startsWith('text/')) return 'text';
  const match = /\.([a-z0-9]{1,8})$/i.exec(name);
  const ext = match?.[1]?.toLowerCase();
  if (ext !== undefined && KNOWLEDGE_TEXT_EXTENSION_ALLOWED[ext] === true) return 'text';
  if (input.type === 'application/json') return 'text';
  return 'unsupported';
}

/** Cap for one kind, or undefined when the kind has no cap (never happens). */
export function knowledgeByteCap(kind: KnowledgeFileKind): number {
  return kind === 'pdf' ? MAX_KNOWLEDGE_PDF_BYTES : MAX_KNOWLEDGE_TEXT_BYTES;
}

export interface KnowledgeDocumentView {
  id: string;
  filename: string;
  mimeType: string;
  kind: KnowledgeFileKind;
  sizeBytes: number;
  status: 'processing' | 'ready' | 'failed';
  chunkCount?: number;
  sourceThreadId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiErrorBody {
  error?: { code?: unknown; message?: unknown };
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    const message = body.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // fall through to the fallback message
  }
  return fallback;
}

/**
 * Fire-and-forget upload of one raw attachment into the Knowledge Base.
 * Resolves with the stored metadata on acceptance (202-class semantics: the
 * response arrives after the raw file + registry record persist, while
 * indexing continues server-side), or a fixed user-safe failure message.
 */
export async function uploadKnowledgeDocument(input: {
  file: File;
  sourceThreadId?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; document: KnowledgeDocumentView } | { ok: false; message: string }> {
  const body = new FormData();
  body.append('file', input.file);
  if (input.sourceThreadId !== undefined) {
    body.append('sourceThreadId', input.sourceThreadId);
  }
  let response: Response;
  try {
    response = await fetch('/api/storage/knowledge/documents', {
      method: 'POST',
      body,
      signal: input.signal,
    });
  } catch {
    return { ok: false, message: 'Knowledge upload failed: network error.' };
  }
  if (!response.ok) {
    const message = await parseError(response, 'Knowledge upload failed.');
    return { ok: false, message };
  }
  const payload = (await response.json().catch(() => null)) as { document?: KnowledgeDocumentView } | null;
  const document = payload?.document;
  if (!document) {
    return { ok: false, message: 'Knowledge upload returned an invalid response.' };
  }
  return { ok: true, document };
}

/** Request deletion of one Knowledge document. The server fires a purge job; poll the list until it disappears. */
export async function deleteKnowledgeDocument(documentId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/storage/knowledge/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    });
  } catch {
    return { ok: false, message: 'Deletion failed: network error.' };
  }
  if (!response.ok) {
    return { ok: false, message: await parseError(response, 'Deletion failed.') };
  }
  return { ok: true };
}

/** Re-run indexing for a failed (or stale-processing) document. */
export async function retryKnowledgeDocumentIngestion(documentId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/storage/knowledge/documents/${encodeURIComponent(documentId)}/retry`, {
      method: 'POST',
    });
  } catch {
    return { ok: false, message: 'Retry failed: network error.' };
  }
  if (!response.ok) {
    return { ok: false, message: await parseError(response, 'Retry failed.') };
  }
  return { ok: true };
}
