import 'server-only';

import type { SocialPostReadResult } from '@chekku/storage';

import { startAgentWorkflow, type AgentWorkflowTriggerDeps } from './agent-workflow';
import { getUserId as getServerUserId } from './auth';
import {
  getSocialPostForUser,
  SocialPostServiceError,
} from './social-posts';

const POST_ID_RE = /^smp_[0-9]{14}_[0-9a-f]{8}$/;

export const REPURPOSE_SOCIAL_POST_WORKFLOW_ID = 'repurpose-social-post';

export interface CaptionStageDeps {
  getServerUserId?: () => Promise<string | null>;
  getPost?: (postId: string) => Promise<SocialPostReadResult>;
  startWorkflow?: (userId: string) => Promise<void>;
  workflowDeps?: AgentWorkflowTriggerDeps;
}

/**
 * Caption stage entry point (Pembahasan 2, stage 1): fire the agent-side
 * `repurpose-social-post` workflow for a DRAFT post after the user approves
 * its canonical content.
 *
 * The transition to `CANONICAL_APPROVED` happens INSIDE the workflow, after
 * the caption is generated and stored — a failed generation leaves the post
 * `DRAFT` so the user can approve again. This function only validates the
 * precondition and starts the run fire-and-forget; the UI observes the post
 * metadata (status flip + `caption.md`) by polling.
 */
export async function triggerCaptionGenerationForUser(
  postId: string,
  deps: CaptionStageDeps = {},
): Promise<void> {
  const userId = await (deps.getServerUserId ?? getServerUserId)();
  if (!userId) {
    throw new SocialPostServiceError('forbidden', 403, 'Authentication is required.');
  }
  if (!POST_ID_RE.test(postId)) {
    throw new SocialPostServiceError('invalid-post-id', 400, 'Invalid social post id.');
  }

  const getPost = deps.getPost ?? ((id: string) => getSocialPostForUser(id));
  const post = await getPost(postId);

  if (post.metadata.status !== 'DRAFT') {
    throw new SocialPostServiceError(
      'invalid-status',
      409,
      `Canonical content can only be approved while the post is DRAFT (current: ${post.metadata.status}).`,
    );
  }

  const start = deps.startWorkflow
    ?? ((uid: string) => startAgentWorkflow(uid, REPURPOSE_SOCIAL_POST_WORKFLOW_ID, { postId }, deps.workflowDeps));
  try {
    await start(userId);
  } catch (error) {
    throw new SocialPostServiceError(
      'job-trigger-failed',
      502,
      error instanceof Error && error.message
        ? error.message
        : 'Could not start the caption generation workflow.',
    );
  }
}
