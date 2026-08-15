import { NextResponse } from 'next/server';

import { ChatPreviewError, getChatPreviewForUser } from '@/server/chat-previews';

/**
 * Serve one chat-side image preview's bytes. Dev-only: the `preview_image`
 * agent tool that writes these previews is registered only outside
 * production, so in production this route returns 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: { code: 'not-available', message: 'Chat previews are dev-only.' } },
      { status: 404 },
    );
  }

  try {
    const { file } = await params;
    const asset = await getChatPreviewForUser(file);
    const headers = new Headers({
      'Content-Type': asset.contentType,
      // Preview ids are timestamp + random and never change once written, so a
      // short immutable cache keeps the route cheap to reload.
      'Cache-Control': 'public, max-age=300, immutable',
    });
    return new Response(Buffer.from(asset.value), { status: 200, headers });
  } catch (error) {
    if (error instanceof ChatPreviewError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load preview.' } },
      { status: 500 },
    );
  }
}
