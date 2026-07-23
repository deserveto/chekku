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
import {
  createPublicHolidayClient,
  type PublicHoliday,
  type PublicHolidayClient,
} from '../calendar/public-holidays.js';
import { createCreateTextObjectTool } from '../tools/garage-object-tools.js';
import { sendEmailViaResend, type SendEmailInput } from '../tools/send-email.js';
import { searchWebTool } from '../tools/searxng-search.js';
import type { SearxngSearchOutput } from '../searxng/client.js';
import {
  evergreenPillarsForWeek,
  selectBonusAwarenessDayForWeek,
  weekStartLabel,
  type SpecialDay,
  type Topic,
} from './special-days.js';
import { researchTrendingTopics, type SearchFn } from './trending-research.js';

/**
 * Scheduled weekly social-drafts workflow (Stage 2).
 *
 * Fires every Monday at 09:00 Asia/Jakarta via Mastra's built-in scheduler
 * (see `agent/src/mastra/index.ts`). One fire drafts 2 base Instagram posts
 * plus, when the week contains an awareness day, 1 bonus awareness post on
 * top (total 2–3 drafts per week).
 *
 * Topic composition:
 * - Base 2 slots, in priority order: trending topics from SearXNG research,
 *   then evergreen pillars as fill when trending returns fewer than 2.
 * - Bonus slot, when the week has a fixed-date awareness day: that day
 *   becomes its own post (every entry in `SPECIAL_DAYS` is eligible, including
 *   national holidays such as `08-17`). The 2 base slots stay "outside big
 *   events" — trending results that overlap the awareness day's theme are
 *   skipped so the bonus and a base slot do not duplicate the same topic.
 *
 * Degraded mode (SearXNG not configured, or every search query fails): the
 * workflow still produces exactly 2 base drafts from evergreen pillars. The
 * awareness-day bonus is gated on a working research pass, so degraded mode
 * never emits awareness-day content for the week.
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
 * schedule/agent/storage/email/search seams can be unit-tested with fakes;
 * the `createStep` binding supplies the real defaults.
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
  /** Human-readable note when research fell back to evergreen pillars. */
  researchNote: z.string().optional(),
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
  const sourceBlock = buildSourceBlock(topic);
  const titleHint = buildTitleHint(topic);
  return `Draft ONE brand greeting-card post for this week's content calendar. The output is greeting-card copy that will be rendered into a brand image, not a traditional Instagram caption.

Topic: ${topic.name}
Angle: ${topic.angle}
${sourceBlock}
Week of: ${weekStart}

Required output structure (produce every line, in this exact order):

R — Your Gentle AI Companion
<blank line>
${titleHint.template}
<canonical date or year line — see rules below; omit entirely when not applicable>
<blank line>
<1-2 sentence reflective opening, warm and professional — not promotional>
<blank line>
<Optional quote block — see rules below; omit entirely when not applicable>
<blank line>
Poin-poin:
- **[Brand value 1]:** <one-line elaboration mapping the topic to this value>
- **[Brand value 2]:** <one-line elaboration>
- **[Brand value 3]:** <one-line elaboration>
<blank line>
AI Human-Centered Intelligence
<blank line>
Hormat kami,
Keluarga Besar PT Rafiq Space Intelligence

Rules:
- Title line: ${titleHint.rule}
- Date/year line: place immediately below the title. For Islamic awareness days, use the Hijri form (e.g. "1447 H" or "1 Muharram 1448 H"). For civic/Gregorian awareness days, use the Indonesian long-form date (e.g. "23 Juli 2026"). For trending and evergreen topics, omit this line entirely — do not output a placeholder or blank line where it would have been.
- Opening: reflective and warm. State what the day/moment means, not what the brand sells.
- Quote block: include ONLY when the topic is a well-known religious or cultural day AND a canonical verse exists. Format the original verse on one line, an Indonesian/English translation in quotes on the next, and the source on the third (e.g. "QS. Al-Hasyr: 18"). Omit the block entirely for trending topics, evergreen pillars, or secular days.
- Poin-poin: exactly 3 to 4 bullets. Each bullet MUST follow this exact format: **[Brand value name]:** <one-line elaboration>. Example: **Human-Centered:** Memanfaatkan teknologi sebagai alat bantu belajar yang menempatkan manusia sebagai pusat. Pick brand values from the canonical set (Human-Centered, Inclusive Growth, Smart Collaboration, AI for Public Good, Gentle Companion, Edukasi, Empati, Aksesibilitas) that genuinely fit the topic — never force one.
- Tone: reflective, warm, professional. Never hype, hard-sell, exclamation overload, or cliché. The brand is a gentle companion, not a vendor.
- For trending topics: the reference URL/title/snippet in the Source block above is research context only — do NOT paste it into the output. Leave a [source] placeholder if a specific claim in the copy needs attribution.
- Output the greeting-card copy only — no preamble, no caption-style hashtags, no "Visual:" line, no explanation.`;
}

/**
 * Title-line template + rule for the greeting-card header, chosen by topic
 * kind. Special days use the "Selamat {day}" greeting; trending topics use a
 * "Tren Minggu Ini: {headline}" header; evergreen pillars fall back to a
 * short themed headline derived from the pillar name.
 */
export function buildTitleHint(topic: Topic): { template: string; rule: string } {
  if (topic.kind === 'special-day') {
    const dateLineRule = topic.hijriYear !== undefined
      ? `Add the line "${topic.hijriYear} Hijriyah" immediately below the title.`
      : `Add the Indonesian long-form Gregorian date (e.g. "23 Juli 2026") immediately below the title when widely known. Skip the date line when not applicable.`;
    return {
      template: `Selamat ${topic.name}`,
      rule: `use "Selamat ${topic.name}" as the title line. ${dateLineRule}`,
    };
  }
  if (topic.kind === 'trending') {
    return {
      template: `Tren Minggu Ini: ${topic.name}`,
      rule: `use "Tren Minggu Ini: ${topic.name}" as the title line. Add a short subtitle line below it only when the topic benefits from a one-line context.`,
    };
  }
  return {
    template: topic.name,
    rule: `use a short themed headline derived from "${topic.name}" as the title line. Avoid generic filler like "Tips" or "Inspirasi" — make the headline specific to the angle.`,
  };
}

/**
 * Render the "Source:" context block for the prompt. Trending topics include
 * the reference title, URL, and snippet so the drafter has research context
 * for the week. The no-invention rule in the prompt still applies — snippets
 * are context, not verified facts — so the drafter still leaves `[source]`
 * placeholders for any specific claim it surfaces.
 */
export function buildSourceBlock(topic: Topic): string {
  if (topic.kind === 'special-day') {
    return `Source: scheduled awareness day — ${topic.specialDay ?? topic.name}.`;
  }
  if (topic.kind === 'trending' && topic.source) {
    const lines = [
      'Source: trending topic from this week\'s web search.',
      `Reference title: ${topic.source.title}`,
      `Reference URL: ${topic.source.url}`,
    ];
    if (topic.source.snippet) lines.push(`Reference snippet: ${topic.source.snippet}`);
    return lines.join('\n');
  }
  return `Source: evergreen content pillar — ${topic.name}.`;
}

export function buildBrief(topic: Topic, weekStart: string): string {
  const lines = [
    'Brief for scheduled Instagram draft',
    '',
    `Week of: ${weekStart}`,
    `Topic: ${topic.name}`,
    `Angle: ${topic.angle}`,
    `Source: ${topic.kind === 'special-day' ? 'special-day' : topic.kind === 'trending' ? 'trending-research' : 'evergreen-pillar'}`,
  ];
  if (topic.specialDay) {
    lines.push(`Special day: ${topic.specialDay}`);
  }
  if (topic.hijriYear !== undefined) {
    lines.push(`Hijri year: ${topic.hijriYear}`);
  }
  if (topic.kind === 'trending' && topic.source) {
    lines.push(`Reference URL: ${topic.source.url}`);
    lines.push(`Reference title: ${topic.source.title}`);
  }
  lines.push('Platform: instagram', 'Status: DRAFT');
  return lines.join('\n');
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
export type SelectBonusAwarenessDayFn = (now: Date) => Promise<SpecialDay | undefined>;

export interface WeeklySocialDraftsDeps {
  now?: () => Date;
  /**
   * Hard override that forces a specific topic list and bypasses the Stage 2
   * research + awareness composition. Kept for the legacy happy-path tests.
   */
  selectTopics?: (now: Date) => Topic[];
  /** SearXNG search seam. `undefined` triggers the degraded (evergreen) path. */
  search?: SearchFn | undefined;
  /** Override the awareness-day bonus picker (defaults to the calendar). */
  selectBonusAwarenessDay?: SelectBonusAwarenessDayFn;
  generate?: DraftGenerateFn;
  createText?: CreateTextFn;
  sendEmail?: SendReviewEmailFn;
  webUrl?: string;
}

const defaultGenerate: DraftGenerateFn = (prompt, instructions) =>
  socialMediaAgent.generate(prompt, { instructions }).then((result) => result.text);

const defaultCreateText: CreateTextFn = (key, text) =>
  defaultCreateTextTool.execute!({ key, text }, SOCIAL_AGENT_CONTEXT).then(() => undefined);

const defaultSendEmail: SendReviewEmailFn = (input) => sendEmailViaResend(input);

// Lazily build the public-holiday client once per process.
// `undefined` = not yet evaluated; `null` = evaluated and disabled (env
// empty); `PublicHolidayClient` = evaluated and ready.
let cachedPublicHolidayClient: PublicHolidayClient | null | undefined;
function getDefaultPublicHolidayClient(): PublicHolidayClient | undefined {
  if (cachedPublicHolidayClient === undefined) {
    cachedPublicHolidayClient = env.PUBLIC_HOLIDAY_API_BASE_URL.trim().length === 0
      ? null
      : createPublicHolidayClient({
          apiUrl: env.PUBLIC_HOLIDAY_API_BASE_URL,
          ...(env.PUBLIC_HOLIDAY_CACHE_DIR
            ? { cacheDir: env.PUBLIC_HOLIDAY_CACHE_DIR }
            : {}),
        });
  }
  return cachedPublicHolidayClient ?? undefined;
}

const defaultSelectBonusAwarenessDay: SelectBonusAwarenessDayFn = async (now) => {
  // When the public-holiday API is reachable, also resolve movable feasts
  // (Idul Fitri, Idul Adha, 1 Muharram, Isra Mi'raj, Maulid Nabi, etc.) for
  // the current year. When it is unconfigured or unreachable, the selector
  // falls through to the fixed-date SPECIAL_DAYS calendar so the workflow
  // still resolves a bonus day for observance days (Hari Kartini, Hari
  // Guru, etc.).
  let publicHolidays: PublicHoliday[] | undefined;
  const client = getDefaultPublicHolidayClient();
  if (client) {
    try {
      publicHolidays = await client.getHolidays(now.getUTCFullYear());
    } catch {
      publicHolidays = undefined;
    }
  }
  return selectBonusAwarenessDayForWeek(now, publicHolidays ? { publicHolidays } : {});
};

// Minimal context for the SearXNG search tool — its execute only reads
// `abortSignal`. The tool's inputSchema is bypassed because the workflow
// controls the input shape directly; we still go through `searchWebTool` so
// the search path, bounding, and normalization remain a single source of
// truth shared with PM Agent.
const SEARCH_TOOL_CONTEXT = { abortSignal: undefined } as never;

/**
 * Build the default SearXNG search seam. Returns `undefined` when
 * `SEARXNG_BASE_URL` is not configured so the orchestrator switches to the
 * degraded evergreen path without making a transport call. Errors from the
 * underlying tool are surfaced to the caller (`researchTrendingTopics`
 * swallows them per-query and triggers the fallback).
 */
export function createDefaultSearch(): SearchFn | undefined {
  if (!env.SEARXNG_BASE_URL || env.SEARXNG_BASE_URL.trim().length === 0) return undefined;
  return async (query: string): Promise<SearxngSearchOutput> => {
    const output = await searchWebTool.execute!(
      { query, maxResults: 10, page: 1, timeRange: 'month' },
      SEARCH_TOOL_CONTEXT,
    );
    return output as SearxngSearchOutput;
  };
}

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
  const weekStart = weekStartLabel(now);
  const webUrl = deps.webUrl ?? env.WEB_URL;
  const generate = deps.generate ?? defaultGenerate;
  const createText = deps.createText ?? defaultCreateText;
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  // The recipient always comes from `SOCIAL_DRAFT_REVIEW_EMAIL`. The workflow
  // has no override seam here — keeping the recipient list in environment
  // config only matches how a scheduled workflow is meant to be operated.
  const reviewEmailTo = env.SOCIAL_DRAFT_REVIEW_EMAIL;
  const search = deps.search ?? createDefaultSearch();
  const selectBonusAwarenessDay = deps.selectBonusAwarenessDay ?? defaultSelectBonusAwarenessDay;

  // Stage 2 topic composition. The legacy `selectTopics` override short-
  // circuits the whole pipeline (still used by the original happy-path
  // tests); otherwise we research → fill → bonus in that order.
  let researchNote: string | undefined;
  let researchFailed = false;
  let topics: Topic[];
  if (deps.selectTopics) {
    topics = deps.selectTopics(now);
  } else {
    const bonusDay = await selectBonusAwarenessDay(now);
    let trending: Topic[] = [];
    if (search) {
      try {
        trending = await researchTrendingTopics(search, {
          ...(bonusDay ? { excludeAwarenessDay: bonusDay.name } : {}),
        });
      } catch (error) {
        researchFailed = true;
        researchNote = error instanceof Error
          ? `SearXNG research failed: ${error.message} Falling back to evergreen pillars.`
          : 'SearXNG research failed. Falling back to evergreen pillars.';;
      }
    } else {
      researchFailed = true;
      researchNote = 'SearXNG is not configured; using evergreen pillars only.';
    }

    topics = trending.slice(0, 2);
    if (topics.length < 2) {
      const fillCount = 2 - topics.length;
      const pillars = evergreenPillarsForWeek(now, fillCount);
      for (const pillar of pillars) {
        if (topics.length >= 2) break;
        topics.push({ kind: 'evergreen', name: pillar.name, angle: pillar.angle });
      }
    }

    // Awareness-day bonus is appended only when research was actually
    // healthy this fire. Degraded mode (no SearXNG, or every query failed)
    // falls all the way back to evergreen pillars with no bonus, so a
    // broken research seam never emits awareness-day content for the week.
    if (!researchFailed && search && bonusDay) {
      topics.push({
        kind: 'special-day',
        name: bonusDay.name,
        angle: bonusDay.angle,
        specialDay: bonusDay.name,
        ...(bonusDay.hijriYear !== undefined ? { hijriYear: bonusDay.hijriYear } : {}),
      });
    }
  }

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
    ok: posts.length >= 2,
    weekStart,
    posts,
    emailSent,
    ...(emailError ? { emailError } : {}),
    ...(researchNote ? { researchNote } : {}),
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
