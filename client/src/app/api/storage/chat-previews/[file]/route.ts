import { NextResponse } from 'next/server';

import { ChatPreviewError, getChatPreviewForUser } from '@/server/chat-previews';

/**
 * Serve one chat-side image preview's bytes. The `preview_image` agent tool
 * that writes these previews is registered in every environment, so this
 * route serves previews in production too (identity-checked through the
 * seam, canonical preview ids only).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  try {
    const { file } = await params;
    const asset = await getChatPreviewForUser(file);
    const headers = new Headers({
      'Content-Type': asset.contentType,
      // Preview ids are timestamp + random and never change once written, so a
      // short immutable cache keeps the route cheap to reload. `private`
      // because the route is session-gated (any signed-in user may fetch a
      // preview id, but shared/browser caches must not retain it).
      'Cache-Control': 'private, max-age=300, immutable',
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
