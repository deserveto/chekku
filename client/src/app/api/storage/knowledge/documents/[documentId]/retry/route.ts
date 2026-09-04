import { NextResponse } from 'next/server';

import {
  KnowledgeServiceError,
  retryKnowledgeDocumentIngestionForUser,
} from '@/server/knowledge';

/**
 * Re-run indexing for a `failed` document, or for one stuck in `processing`
 * past the stale-run window (e.g. the agent server restarted mid-run).
 * Fire-and-forget: the route only validates eligibility and triggers the
 * ingestion workflow; the document flips back to `processing` inside the
 * workflow and the UI polls for the transition.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    await retryKnowledgeDocumentIngestionForUser(documentId);
    return NextResponse.json({ ok: true, pendingIngest: true });
  } catch (error) {
    if (error instanceof KnowledgeServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not retry knowledge indexing.' } },
      { status: 500 },
    );
  }
}
