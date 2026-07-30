import { NextResponse } from 'next/server';

import {
  approveSocialPostForUser,
  getSocialPostForUser,
  SocialPostServiceError,
} from '@/server/social-posts';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  try {
    const { postId } = await params;
    return NextResponse.json(await getSocialPostForUser(postId));
  } catch (error) {
    if (error instanceof SocialPostServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load social post.' } },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  try {
    const { postId } = await params;
    const body = await request.json().catch(() => ({}));
    if (body?.status !== 'APPROVED') {
      return NextResponse.json(
        { error: { code: 'invalid-status', message: 'Only status "APPROVED" is supported.' } },
        { status: 400 },
      );
    }
    const metadata = await approveSocialPostForUser(postId);
    return NextResponse.json({ metadata });
  } catch (error) {
    if (error instanceof SocialPostServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not update social post.' } },
      { status: 500 },
    );
  }
}
