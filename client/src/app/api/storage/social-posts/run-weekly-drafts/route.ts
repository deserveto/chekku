import { NextResponse } from 'next/server';

import { getDownstreamToken, requireUserId } from '@/server/auth';

/**
 * Manually trigger the `weekly-social-drafts` workflow on demand (dev-only).
 *
 * The workflow is normally cron-only (Mondays 09:00 Asia/Jakarta). This route
 * opens a fire-and-forget manual trigger so a developer can produce DRAFT
 * posts any time for local testing of the review→approve→visual flow. It is
 * gated to non-production: production keeps the schedule as the sole entry
 * point.
 *
 * The route calls the agent server DIRECTLY (not via the browser `mastraClient`
 * loop-back through `/api/agent/*`), because this is a server-side handler
 * with no session cookie to satisfy the proxy's `getUserId()` gate. It reuses
 * the same downstream token the proxy attaches. It creates a run, then starts
 * it fire-and-forget; the workflow continues server-side and posts appear on
 * `/social-posts` once written.
 */
const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:4111';
const WORKFLOW_ID = 'weekly-social-drafts';

export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: { code: 'not-available', message: 'Manual workflow trigger is dev-only.' } },
      { status: 404 },
    );
  }

  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Sign in required.' } },
      { status: 403 },
    );
  }

  try {
    const token = await getDownstreamToken(userId);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    // 1. Create a run record and obtain its runId.
    const createRes = await fetch(
      `${AGENT_URL}/api/workflows/${WORKFLOW_ID}/create-run`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        // Node fetch requires duplex for streaming request bodies.
        // @ts-expect-error duplex is not in the lib.dom types but is required by Node.
        duplex: 'half',
      },
    );
    if (!createRes.ok) {
      throw new Error(`create-run failed with status ${createRes.status}`);
    }
    const created = (await createRes.json().catch(() => ({}))) as { runId?: string };
    const runId = created?.runId;
    if (!runId) {
      throw new Error('create-run returned no runId');
    }

    // 2. Start the run fire-and-forget (returns without waiting for completion).
    const startRes = await fetch(
      `${AGENT_URL}/api/workflows/${WORKFLOW_ID}/start?runId=${encodeURIComponent(runId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ inputData: {} }),
        // @ts-expect-error duplex is not in the lib.dom types but is required by Node.
        duplex: 'half',
      },
    );
    if (!startRes.ok) {
      throw new Error(`start failed with status ${startRes.status}`);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: 'workflow-trigger-failed',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'Could not start the weekly drafts workflow.',
        },
      },
      { status: 502 },
    );
  }
}
