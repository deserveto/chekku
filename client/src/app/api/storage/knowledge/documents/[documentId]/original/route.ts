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
    // Stored content types are client-declared and attacker-controllable.
    // Only PDF is served inline; everything else downloads as opaque bytes
    // so attacker-uploaded HTML/SVG can never execute on the app origin
    // (stored self-XSS hardening, mirroring the visual-asset route's fixed
    // allowlist pattern).
    const isPdf = bytes.contentType === 'application/pdf';
    return new NextResponse(new Uint8Array(bytes.value), {
      status: 200,
      headers: {
        'Content-Type': isPdf ? 'application/pdf' : 'application/octet-stream',
        'Content-Disposition': `${isPdf ? 'inline' : 'attachment'}; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
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
