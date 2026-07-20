import { NextResponse } from 'next/server';

import {
  listSocialPostsForUser,
  SocialPostServiceError,
} from '@/server/social-posts';

export async function GET() {
  try {
    const posts = await listSocialPostsForUser();
    return NextResponse.json({ posts });
  } catch (error) {
    if (error instanceof SocialPostServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load social posts.' } },
      { status: 500 },
    );
  }
}
