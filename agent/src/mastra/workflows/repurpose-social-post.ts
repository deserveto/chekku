import { createWorkflow, createStep } from '@mastra/core/workflows';
import {
  attachCaptionToPost,
  createLazyGarageObjectStorage,
  createSocialPostStorage,
  getSocialPost,
  ObjectStorageError,
  type ObjectStorage,
} from '@chekku/storage';
import { z } from 'zod';

import { unwrapPostMarkdown } from '../social-content/canonical-unit.js';
import type { Topic } from './special-days.js';
import {
  buildRepurposePrompt,
  createSocialPostCreateText,
  defaultRepurpose,
  parseBrief,
  type CreateTextFn,
  type RepurposeFn,
} from './weekly-social-drafts.js';

/**
 * Approval-driven caption stage (Pembahasan 2 — 2-stage approval).
 *
 * Fired by the client when the user approves a post's canonical content in
 * `/social-posts` (PATCH `DRAFT → CANONICAL_APPROVED`). Reads the stored
 * canonical-only `post.md`, reconstructs the drafting topic from the stored
 * brief, asks the Content Writer (running in repurpose mode via
 * `requestContext`) to derive the Instagram caption, writes it to
 * `caption.md` through the same Garage MCP `create_text_object` seam the
 * weekly workflow uses, and finally transitions the post to
 * `CANONICAL_APPROVED` via the narrow storage helper `attachCaptionToPost`
 * (metadata written last, so a partial run never flips the status without a
 * caption).
 *
 * The transition happens ONLY after a successful caption generation: if the
 * LLM call or the writes fail, the post stays `DRAFT` and the user can
 * approve again. There is no scheduler — the only entry points are manual
 * `workflow.start()` calls from the client seam.
 */

const POST_ID_RE = /^smp_[0-9]{14}_[0-9a-f]{8}$/;

export const repurposeSocialPostInputSchema = z.object({
  postId: z.string().regex(POST_ID_RE, 'Invalid social post id.'),
});

export const repurposeSocialPostOutputSchema = z.object({
  ok: z.boolean(),
  postId: z.string(),
  captionObjectKey: z.string().optional(),
  error: z.string().optional(),
});

export type RepurposeSocialPostResult = z.infer<typeof repurposeSocialPostOutputSchema>;

export type { RepurposeFn };

export interface RepurposeSocialPostDeps {
  now?: () => Date;
  storeFactory?: () => ObjectStorage;
  /** Seam for the repurpose LLM call — override in tests. */
  repurpose?: RepurposeFn;
  /** Seam for the caption-object write — override in tests. */
  createText?: CreateTextFn;
}

const defaultCreateText: CreateTextFn = createSocialPostCreateText('repurpose-social-post');

/**
 * Reconstruct the drafting topic for the repurpose prompt. Prefers the stored
 * brief (deterministic inverse of `buildBrief`); falls back to a minimal
 * greeting-card topic from metadata so legacy or foreign briefs still
 * produce a valid prompt instead of failing the stage.
 */
export function resolveTopicForRepurpose(
  briefMarkdown: string,
  metadata: { topic: string; createdAt: string; specialDay?: string },
): { weekStart: string; topic: Topic } {
  const parsed = parseBrief(briefMarkdown);
  if (parsed) return parsed;
  return {
    weekStart: metadata.createdAt.slice(0, 10),
    topic: {
      kind: metadata.specialDay ? 'special-day' : 'evergreen',
      name: metadata.topic,
      angle: '',
      ...(metadata.specialDay ? { specialDay: metadata.specialDay } : {}),
    },
  };
}

export async function runRepurposeSocialPost(
  input: z.infer<typeof repurposeSocialPostInputSchema>,
  deps: RepurposeSocialPostDeps = {},
): Promise<RepurposeSocialPostResult> {
  const { postId } = input;
  const store = createSocialPostStorage((deps.storeFactory ?? createLazyGarageObjectStorage)());
  const repurpose = deps.repurpose ?? defaultRepurpose;
  const createText = deps.createText ?? defaultCreateText;

  let post: Awaited<ReturnType<typeof getSocialPost>>;
  try {
    post = await getSocialPost(store, postId);
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === 'not-found') {
      return { ok: false, postId, error: 'not-found' };
    }
    console.error('[repurpose-social-post] could not read post:', error);
    return { ok: false, postId, error: 'storage-read-failed' };
  }

  // Only DRAFT posts enter the caption stage. A double-fired run (or a post
  // that already advanced) is rejected instead of rewriting history.
  if (post.metadata.status !== 'DRAFT') {
    return { ok: false, postId, error: `unexpected-status-${post.metadata.status.toLowerCase()}` };
  }

  const { canonicalMarkdown } = unwrapPostMarkdown(post.postMarkdown);
  if (!canonicalMarkdown) {
    // Legacy caption-only post (pre-canonical contract): nothing to derive a
    // caption from — the embedded caption stays as-is.
    return { ok: false, postId, error: 'canonical-missing' };
  }

  const { weekStart, topic } = resolveTopicForRepurpose(post.briefMarkdown, {
    topic: post.metadata.topic,
    createdAt: post.metadata.createdAt,
    ...(post.metadata.specialDay ? { specialDay: post.metadata.specialDay } : {}),
  });

  let captionMarkdown: string;
  try {
    captionMarkdown = await repurpose(buildRepurposePrompt(canonicalMarkdown, topic, weekStart));
  } catch (error) {
    console.error('[repurpose-social-post] caption generation failed:', error);
    return { ok: false, postId, error: 'caption-generation-failed' };
  }

  if (!captionMarkdown.trim()) {
    console.error('[repurpose-social-post] caption generation returned empty output');
    return { ok: false, postId, error: 'caption-empty' };
  }

  try {
    // Body first (create-conditional MCP write), metadata transition last —
    // mirrors the brief → post → metadata creation order.
    const captionObjectKey = `social-posts/${postId}/caption.md`;
    await createText(captionObjectKey, captionMarkdown);
    const metadata = await attachCaptionToPost(store, postId, {
      ...(deps.now ? { now: deps.now } : {}),
    });
    return { ok: true, postId, captionObjectKey: metadata.captionObjectKey };
  } catch (error) {
    console.error('[repurpose-social-post] could not persist caption:', error);
    return { ok: false, postId, error: 'caption-persist-failed' };
  }
}

const runRepurposeSocialPostStep = createStep({
  id: 'run-repurpose-social-post',
  inputSchema: repurposeSocialPostInputSchema,
  outputSchema: repurposeSocialPostOutputSchema,
  execute: async ({ inputData }) => runRepurposeSocialPost(inputData),
});

/**
 * Manual-trigger workflow (no schedule). Started fire-and-forget by the
 * client seam after canonical approval; observers watch the post metadata
 * (status flips to `CANONICAL_APPROVED` + `caption.md` appears) rather than
 * the workflow run.
 */
export const repurposeSocialPost = createWorkflow({
  id: 'repurpose-social-post',
  inputSchema: repurposeSocialPostInputSchema,
  outputSchema: repurposeSocialPostOutputSchema,
})
  .then(runRepurposeSocialPostStep)
  .commit();
