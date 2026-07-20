import { NextResponse } from 'next/server';

import {
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
