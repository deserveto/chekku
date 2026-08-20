import 'server-only';

import type { SocialPostReadResult } from '@chekku/storage';

import { startAgentWorkflow, type AgentWorkflowTriggerDeps } from './agent-workflow';
import { getUserId as getServerUserId } from './auth';
import {
  getSocialPostForUser,
  SocialPostServiceError,
} from './social-posts';

const POST_ID_RE = /^smp_[0-9]{14}_[0-9a-f]{8}$/;

export const GENERATE_SOCIAL_POST_VISUAL_WORKFLOW_ID = 'generate-social-post-visual';

export interface ImageStageDeps {
  getServerUserId?: () => Promise<string | null>;
  getPost?: (postId: string) => Promise<SocialPostReadResult>;
  startWorkflow?: (userId: string) => Promise<void>;
  workflowDeps?: AgentWorkflowTriggerDeps;
}

/**
 * Image stage entry point (Pembahasan 2, stage 2): fire the agent-side
 * `generate-social-post-visual` workflow for a CANONICAL_APPROVED post after
 * the user approves its caption.
 *
 * The transition to `APPROVED` (which unblocks the `generate_image` gate)
 * happens INSIDE the workflow, right before the Visual Content Agent runs.
 * A failed generation keeps the post `APPROVED` without a visual — the user
 * can retry manually through the supervisor chat. This function only
 * validates the precondition and starts the run fire-and-forget; the UI
 * observes the post metadata (a `visualAssets` entry appears) by polling.
 */
export async function startImageGenerationForUser(
  postId: string,
  deps: ImageStageDeps = {},
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

  if (post.metadata.status !== 'CANONICAL_APPROVED') {
    throw new SocialPostServiceError(
      'invalid-status',
      409,
      `The caption can only be approved while the post is CANONICAL_APPROVED (current: ${post.metadata.status}).`,
    );
  }

  const start = deps.startWorkflow
    ?? ((uid: string) => startAgentWorkflow(uid, GENERATE_SOCIAL_POST_VISUAL_WORKFLOW_ID, { postId }, deps.workflowDeps));
  try {
    await start(userId);
  } catch (error) {
    throw new SocialPostServiceError(
      'job-trigger-failed',
      502,
      error instanceof Error && error.message
        ? error.message
        : 'Could not start the visual generation workflow.',
    );
  }
}
