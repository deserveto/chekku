import { NextResponse } from 'next/server';

import {
  getSocialPostVisualAssetForUser,
  SocialPostServiceError,
} from '@/server/social-posts';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ postId: string; assetId: string }> },
) {
  try {
    const { postId, assetId } = await params;
    const asset = await getSocialPostVisualAssetForUser(postId, assetId);
    const headers = new Headers({
      'Content-Type': asset.contentType,
      // The asset id is content-addressed (timestamp + random) and never
      // changes once written, so a short immutable cache is safe and keeps the
      // image route cheap to reload.
      'Cache-Control': 'public, max-age=300, immutable',
    });
    return new Response(Buffer.from(asset.value), { status: 200, headers });
  } catch (error) {
    if (error instanceof SocialPostServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load visual asset.' } },
      { status: 500 },
    );
  }
}
