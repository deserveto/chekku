import { NextResponse } from 'next/server';

import {
  KnowledgeServiceError,
  listKnowledgeDocumentsForUser,
  uploadKnowledgeDocumentForUser,
} from '@/server/knowledge';

export async function GET() {
  try {
    const documents = await listKnowledgeDocumentsForUser();
    return NextResponse.json({ documents });
  } catch (error) {
    if (error instanceof KnowledgeServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load knowledge documents.' } },
      { status: 500 },
    );
  }
}

/**
 * Persist one uploaded attachment into the caller's Knowledge Base. The raw
 * document and its `processing` registry record are durable when this
 * returns; indexing continues server-side (fire-and-forget workflow) and the
 * client polls the list/metadata endpoints for the status transition.
 *
 * Body: multipart/form-data with `file` (raw bytes) and optional
 * `sourceThreadId`. Identity comes from the session, never from the body.
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File)) {
      return NextResponse.json(
        { error: { code: 'invalid-document', message: 'A "file" part is required.' } },
        { status: 400 },
      );
    }
    const sourceThreadIdRaw = form.get('sourceThreadId');
    const sourceThreadId = typeof sourceThreadIdRaw === 'string' && sourceThreadIdRaw.length > 0
      ? sourceThreadIdRaw
      : undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const document = await uploadKnowledgeDocumentForUser({
      file: { name: file.name, type: file.type, bytes },
      sourceThreadId,
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    if (error instanceof KnowledgeServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not add this file to Knowledge.' } },
      { status: 500 },
    );
  }
}
