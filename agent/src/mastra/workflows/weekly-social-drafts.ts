import { createWorkflow, createStep } from '@mastra/core/workflows';
import {
  buildSocialPostMetadata,
  SOCIAL_MEDIA_AGENT_ID,
  type SocialPostMetadata,
  type SocialPostMetadataInput,
} from '@chekku/storage';
import { z } from 'zod';

import { socialMediaAgent, buildInstructionsForRole } from '../../agents/social-media-agent.js';
import { env } from '../../config/env.js';
import { createCreateTextObjectTool } from '../tools/garage-object-tools.js';
import { sendEmailViaResend, type SendEmailInput } from '../tools/send-email.js';
import { selectTopicsForWeek, weekStartLabel, type Topic } from './special-days.js';

/**
 * Scheduled weekly social-drafts workflow (Stage 1).
 *
 * Fires every Monday at 09:00 Asia/Jakarta via Mastra's built-in scheduler
 * (see `agent/src/mastra/index.ts`). One fire produces exactly 2 Instagram
 * drafts: up to 2 awareness days in the week, filled out by evergreen pillars,
 * then persists each to the `social-media-agent` Garage namespace and emails a
 * review link to `SOCIAL_DRAFT_REVIEW_EMAIL`.
 *
 * Storage writes go through the existing Garage MCP `create_text_object` tool
 * (the same five-tool generic MCP registered on the Mastra instance), invoked
 * with a trusted context that pins `agentId` to `social-media-agent`. This
 * matches the meeting brief ("attach the existing MCP and call it from the
 * workflow"): we reuse the agent-facing storage contract instead of bypassing
 * it, while keeping canonical post id / key / metadata construction
 * deterministic via `buildSocialPostMetadata`.
 *
 * The drafter reuses `socialMediaAgent` so the Instagram voice stays a single
 * source of truth (the `instagram-writer` role). Because the workflow runs
 * outside any chat channel, the role cannot be resolved from channel context;
 * we pin it by overriding the agent's instructions via `generate(..., {
 * instructions })`.
 *
 * The orchestrator (`runWeeklySocialDrafts`) is dependency-injected so the
 * schedule/agent/storage/email seams can be unit-tested with fakes; the
 * `createStep` binding supplies the real defaults.
 */

const INSTAGRAM_INSTRUCTIONS = buildInstructionsForRole('instagram-writer');

// ---------------------------------------------------------------------------
// Garage MCP tool wiring
// ---------------------------------------------------------------------------
// The `create_text_object` MCP tool derives its storage namespace from
// `context.agent.agentId`. We pin that to SOCIAL_MEDIA_AGENT_ID so writes
// land in the same physical namespace the read path (client/server, via
// `@chekku/storage`) reads from — no parallel storage surface, no second
// source of truth for namespace.
const defaultCreateTextTool = createCreateTextObjectTool();

const SOCIAL_AGENT_CONTEXT = {
  agent: {
    agentId: SOCIAL_MEDIA_AGENT_ID,
    toolCallId: 'weekly-social-drafts',
    messages: [],
    suspend: async () => undefined,
  },
} as never;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------
const draftedPostSchema = z.object({
  postId: z.string(),
  postUrl: z.string(),
  topic: z.string(),
  specialDay: z.string().optional(),
  status: z.enum(['DRAFT', 'APPROVED', 'PUBLISHED']),
  createdAt: z.string(),
});

export const weeklySocialDraftsOutputSchema = z.object({
  ok: z.boolean(),
  weekStart: z.string(),
  posts: z.array(draftedPostSchema),
  emailSent: z.boolean(),
  emailError: z.string().optional(),
});

export type DraftedPost = z.infer<typeof draftedPostSchema>;
export type WeeklySocialDraftsResult = z.infer<typeof weeklySocialDraftsOutputSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (deterministic, unit-tested without any I/O)
// ---------------------------------------------------------------------------
export function buildPostUrl(postId: string, webUrl: string): string {
  const base = webUrl.replace(/\/+$/, '');
  return `${base}/social-posts/${encodeURIComponent(postId)}`;
}

export function buildDraftPrompt(topic: Topic, weekStart: string): string {
  const sourceLine =
    topic.kind === 'special-day'
      ? `Source: scheduled awareness day — ${topic.specialDay ?? topic.name}.`
      : `Source: evergreen content pillar — ${topic.name}.`;
  return `Draft ONE Instagram post for this week's content calendar.

Topic: ${topic.name}
Angle: ${topic.angle}
${sourceLine}
Week of: ${weekStart}

Requirements:
- Produce exactly one ready-to-post Instagram caption.
- Open with a scroll-stopping first line; use line breaks for readability.
- Close with a clear call to action and a targeted hashtag set (mix broad and niche).
- Add a single short line of visual direction at the end prefixed with "Visual:".
- Never invent quotes, statistics, or facts; leave a [source] placeholder if a claim needs one.
- Output the caption only — no preamble, no explanation.`;
}

export function buildBrief(topic: Topic, weekStart: string): string {
  return [
    'Brief for scheduled Instagram draft',
    '',
    `Week of: ${weekStart}`,
    `Topic: ${topic.name}`,
    `Angle: ${topic.angle}`,
    `Source: ${topic.kind === 'special-day' ? 'special-day' : 'evergreen-pillar'}`,
    ...(topic.specialDay ? [`Special day: ${topic.specialDay}`] : []),
    'Platform: instagram',
    'Status: DRAFT',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ReviewEmailParts {
  subject: string;
  html: string;
  text: string;
}

export function renderReviewEmail(
  posts: readonly DraftedPost[],
  options: { weekStart: string },
): ReviewEmailParts {
  const count = posts.length;
  const plural = count === 1 ? '' : 's';
  const subject = `[Chekku Social] ${count} Instagram draft${plural} ready for review — week of ${options.weekStart}`;

  const text = [
    `Social drafts ready for review (week of ${options.weekStart}).`,
    '',
    ...posts.map((post, index) => {
      const label = post.specialDay ?? post.topic;
      return `${index + 1}. ${label}\n   ${post.postUrl}`;
    }),
    '',
    'Open a link to review and approve before publishing.',
  ].join('\n');

  const items = posts
    .map((post) => {
      const label = escapeHtml(post.specialDay ?? post.topic);
      return `<li><a href="${post.postUrl}">${label}</a></li>`;
    })
    .join('');

  const html = [
    '<h2>Social drafts ready for review</h2>',
    `<p>Week of ${escapeHtml(options.weekStart)}. ${count} Instagram draft${plural} generated by the scheduled workflow.</p>`,
    `<ul>${items}</ul>`,
    '<p>Open a link to review and approve before publishing.</p>',
  ].join('');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Dependency-injected orchestrator
// ---------------------------------------------------------------------------
export type DraftGenerateFn = (prompt: string, instructions: string) => Promise<string>;
export type CreateTextFn = (key: string, text: string) => Promise<void>;
export type SendReviewEmailFn = (input: SendEmailInput) => Promise<unknown>;

export interface WeeklySocialDraftsDeps {
  now?: () => Date;
  selectTopics?: (now: Date) => Topic[];
  generate?: DraftGenerateFn;
  createText?: CreateTextFn;
  sendEmail?: SendReviewEmailFn;
  reviewEmailTo?: string;
  webUrl?: string;
}

const defaultGenerate: DraftGenerateFn = (prompt, instructions) =>
  socialMediaAgent.generate(prompt, { instructions }).then((result) => result.text);

const defaultCreateText: CreateTextFn = (key, text) =>
  defaultCreateTextTool.execute!({ key, text }, SOCIAL_AGENT_CONTEXT).then(() => undefined);

const defaultSendEmail: SendReviewEmailFn = (input) => sendEmailViaResend(input);

/**
 * Persist one social post via the Garage MCP `create_text_object` tool.
 *
 * Writes happen in the canonical order — brief → post → metadata — so a
 * partial save never becomes a list entry: the listing filters out any
 * `social-posts/<postId>/metadata.json` that is absent or fails validation.
 */
async function savePostViaMcp(
  input: SocialPostMetadataInput,
  createText: CreateTextFn,
): Promise<SocialPostMetadata> {
  const built = buildSocialPostMetadata(input);
  await createText(built.briefObjectKey, input.briefMarkdown);
  await createText(built.postObjectKey, input.postMarkdown);
  await createText(built.metadataObjectKey, built.metadataJson);
  return built.metadata;
}

export async function runWeeklySocialDrafts(
  deps: WeeklySocialDraftsDeps = {},
): Promise<WeeklySocialDraftsResult> {
  const now = deps.now?.() ?? new Date();
  const select = deps.selectTopics ?? selectTopicsForWeek;
  const topics = select(now);
  const weekStart = weekStartLabel(now);
  const webUrl = deps.webUrl ?? env.WEB_URL;
  const generate = deps.generate ?? defaultGenerate;
  const createText = deps.createText ?? defaultCreateText;
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const reviewEmailTo = deps.reviewEmailTo ?? env.SOCIAL_DRAFT_REVIEW_EMAIL;

  const posts: DraftedPost[] = [];
  for (const topic of topics) {
    const prompt = buildDraftPrompt(topic, weekStart);
    const postMarkdown = await generate(prompt, INSTAGRAM_INSTRUCTIONS);
    const metadata = await savePostViaMcp({
      postMarkdown,
      briefMarkdown: buildBrief(topic, weekStart),
      topic: topic.name,
      platform: 'instagram',
      status: 'DRAFT',
      ...(topic.specialDay ? { specialDay: topic.specialDay } : {}),
      now: () => now,
    }, createText);
    posts.push({
      postId: metadata.postId,
      postUrl: buildPostUrl(metadata.postId, webUrl),
      topic: metadata.topic,
      ...(metadata.specialDay ? { specialDay: metadata.specialDay } : {}),
      status: metadata.status,
      createdAt: metadata.createdAt,
    });
  }

  const email = renderReviewEmail(posts, { weekStart });
  let emailSent = false;
  let emailError: string | undefined;
  // Skip the email step entirely when no recipient is configured — drafts are
  // already saved, so the run is still a success. Recording an explicit error
  // here avoids relying on Resend to surface a "missing to" failure and tells
  // operators exactly which env var to set.
  if (!reviewEmailTo || reviewEmailTo.trim().length === 0) {
    emailError = 'SOCIAL_DRAFT_REVIEW_EMAIL is not set; skipping email delivery.';
  } else {
    try {
      await sendEmail({
        to: reviewEmailTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      emailSent = true;
    } catch (error) {
      emailError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: posts.length === 2,
    weekStart,
    posts,
    emailSent,
    ...(emailError ? { emailError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Workflow + scheduled step
// ---------------------------------------------------------------------------
const runWeeklySocialDraftsStep = createStep({
  id: 'run-weekly-social-drafts',
  inputSchema: z.object({}),
  outputSchema: weeklySocialDraftsOutputSchema,
  execute: async () => runWeeklySocialDrafts(),
});

/**
 * Weekly scheduled workflow. Fires Mondays at 09:00 Asia/Jakarta. The scheduler
 * reads the `schedule` field on boot and runs the step on the cron — no separate
 * registration call. Scheduled fires and manual `workflow.start()` share the
 * same execution path.
 */
export const weeklySocialDrafts = createWorkflow({
  id: 'weekly-social-drafts',
  inputSchema: z.object({}),
  outputSchema: weeklySocialDraftsOutputSchema,
  schedule: { cron: '0 9 * * 1', timezone: 'Asia/Jakarta', inputData: {} },
})
  .then(runWeeklySocialDraftsStep)
  .commit();
