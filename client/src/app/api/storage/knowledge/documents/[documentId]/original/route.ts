import { NextResponse } from 'next/server';

import {
  KnowledgeServiceError,
  readKnowledgeDocumentOriginalForUser,
} from '@/server/knowledge';

/**
 * Authenticated byte route for one Knowledge document's original upload.
 * Identity comes from the session; the storage key comes from the verified
 * metadata (never from the URL), so this can never become an arbitrary
 * object reader. Private caching only — these are user-owned files.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    const bytes = await readKnowledgeDocumentOriginalForUser(documentId);
    const safeName = documentId.replace(/[^a-zA-Z0-9_-]/g, '');
    return new NextResponse(new Uint8Array(bytes.value), {
      status: 200,
      headers: {
        'Content-Type': bytes.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, max-age=60',
      },
    });
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
