import { NextResponse } from 'next/server';

import {
  getSocialPostForUser,
  SocialPostServiceError,
} from '@/server/social-posts';
import { triggerCaptionGenerationForUser } from '@/server/social-post-caption';
import { startImageGenerationForUser } from '@/server/social-post-image-job';

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

/**
 * Multi-stage approval (Pembahasan 2):
 *
 * - `{ status: 'CANONICAL_APPROVED' }` — approve the canonical content of a
 *   DRAFT post; fires the caption generation workflow in the background.
 * - `{ status: 'APPROVED' }` — approve the caption of a CANONICAL_APPROVED
 *   post; fires the visual generation workflow in the background.
 *
 * The route only validates the requested stage and starts the corresponding
 * background job; the actual status transition happens inside the job after
 * its work succeeds, so a failed job never locks the post in an intermediate
 * state. The client polls GET (or refreshes) until the metadata advances.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ postId: string }> },
) {
  try {
    const { postId } = await params;
    const body = await request.json().catch(() => ({}));
    const nextStatus = body?.status;

    if (nextStatus === 'CANONICAL_APPROVED') {
      await triggerCaptionGenerationForUser(postId);
      return NextResponse.json({ ok: true, pendingStatus: nextStatus });
    }
    if (nextStatus === 'APPROVED') {
      await startImageGenerationForUser(postId);
      return NextResponse.json({ ok: true, pendingStatus: nextStatus });
    }

    return NextResponse.json(
      {
        error: {
          code: 'invalid-status',
          message: 'Only status "CANONICAL_APPROVED" or "APPROVED" is supported.',
        },
      },
      { status: 400 },
    );
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
