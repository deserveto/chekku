import { NextResponse } from 'next/server';

import {
  KnowledgeServiceError,
  deleteKnowledgeDocumentForUser,
  getKnowledgeDocumentForUser,
} from '@/server/knowledge';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    return NextResponse.json(await getKnowledgeDocumentForUser(documentId));
  } catch (error) {
    if (error instanceof KnowledgeServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load knowledge document.' } },
      { status: 500 },
    );
  }
}

/**
 * Request deletion of one Knowledge document. Fire-and-forget: the agent-side
 * purge workflow removes vectors first, then objects, then the metadata
 * record LAST — so the document stops being retrievable before it disappears
 * from the list. Clients poll GET until it 404s.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    await deleteKnowledgeDocumentForUser(documentId);
    return NextResponse.json({ ok: true, pendingDelete: true });
  } catch (error) {
    if (error instanceof KnowledgeServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not delete knowledge document.' } },
      { status: 500 },
    );
  }
}
