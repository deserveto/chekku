import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import type { ChannelHandler } from '@mastra/core/channels';
import { RequestContext } from '@mastra/core/request-context';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Channel, Chat, Message, Thread } from 'chat';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { createTaskNudgeProcessor } from '../mastra/tasks/task-nudge-processor.js';
import { TASK_GUIDANCE, createTaskSignals } from '../mastra/tasks/task-signals.js';
import {
  CANONICAL_UNIT_TEMPLATE,
  type CanonicalContentUnit,
  parseCanonicalUnit,
  renderCanonicalUnit,
} from '../mastra/social-content/canonical-unit.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { sendEmailTool } from '../mastra/tools/send-email.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

/**
 * Social Media Content Writer
 *
 * The drafting sub-agent under the Social Media Supervisor. A generic,
 * role-switchable social media content writer exposed over a Mastra channel
 * (Telegram today, other platforms later). Users drive it from a chat
 * platform: they ask it to draft / repurpose / schedule posts, and switch the
 * active "role" to tune voice for a specific platform via slash commands
 * (`/switch`, `/roles`, `/role`, `/help`).
 *
 * Phase scope: the agent drafts and plans posts inside the chat. Actual
 * publishing to destination platforms is a later phase.
 *
 * The Telegram channel and slash commands stay on this agent (not the
 * supervisor) for this refactor; the supervisor delegates to it via the
 * Mastra `agents` sub-agent field.
 *
 * Storage namespace note: social posts live under the fixed Garage namespace
 * `social-media-agent` (see `SOCIAL_MEDIA_AGENT_ID` in `@chekku/storage`),
 * which is decoupled from this agent's identity string. The workflow pins that
 * namespace explicitly when writing; the agent itself does not attach the
 * Garage MCP tools.
 *
 * Model routing uses the same Chekku gateway as the other agents
 * (`getServerModel()`); provider fallbacks and API keys live entirely
 * server-side per the model gateway invariant in AGENTS.md.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
export interface SocialRole {
  id: string;
  label: string;
  description: string;
  guidance: string;
}

export const SOCIAL_ROLES: readonly SocialRole[] = [
  {
    id: 'general',
    label: 'General Social Assistant',
    description: 'Platform-agnostic drafting, repurposing, and content planning.',
    guidance:
      'Write in a clear, adaptable voice. When the user does not name a platform, produce a strong general-purpose draft and briefly note how it could be tailored for X, Instagram, and LinkedIn.',
  },
  {
    id: 'x-writer',
    label: 'X / Twitter Writer',
    description: 'Punchy tweets, hooks, and threads under the character limit.',
    guidance:
      'Write for X (Twitter). Default to single tweets ≤280 characters; offer a thread when an idea needs more room. Lead with a strong hook, use 1–3 relevant hashtags sparingly, and keep punctuation tight. Preserve URLs and @handles the user provides.',
  },
  {
    id: 'instagram-writer',
    label: 'Instagram Writer',
    description: 'Brand-voiced greeting cards, captions, and hashtag sets on Instagram.',
    guidance:
      'Write for Instagram on behalf of the brand "R — Your Gentle AI Companion" (tagline: "AI Human-Centered Intelligence"; sign-off: "Hormat kami, Keluarga Besar PT Rafiq Space Intelligence"). Voice is reflective, warm, and professional — never hype, hard-sell, or cliché. Brand values emerge naturally from the topic; never force them. Well-known religious and cultural verses (e.g. Quran with translation + Surah reference, Bible with book + chapter:verse) may be quoted with proper attribution; statistics, scientific claims, and any unverifiable fact still require a [source] placeholder. Lead with a scroll-stopping first line, use line breaks for readability, pair an engaging caption with a clear CTA when the format calls for it, and end with a targeted hashtag set (mix broad and niche). Suggest a visual direction in one line when relevant.',
  },
  {
    id: 'linkedin-writer',
    label: 'LinkedIn Writer',
    description: 'Professional, thought-leadership posts with readable formatting.',
    guidance:
      'Write for LinkedIn. Use a professional, insightful tone. Open with a hook worth pausing for, develop one clear idea, use short paragraphs and bullet points, and close with a question that invites comments. Avoid clickbait.',
  },
  {
    id: 'tiktok-writer',
    label: 'TikTok Writer',
    description: 'Trend-aware video ideas, hooks, scripts, and captions.',
    guidance:
      'Write for TikTok. Lead with a 1–2 second scroll-stopping hook, give a short shot-by-shot script or idea, keep the on-screen text minimal, and add a caption with 3–5 trending-style hashtags. Note the sound/trend direction when relevant.',
  },
] as const;

const ROLE_IDS = SOCIAL_ROLES.map((r) => r.id);
const DEFAULT_ROLE_ID = 'general';

export function getRole(roleId: string | undefined): SocialRole {
  return SOCIAL_ROLES.find((r) => r.id === roleId) ?? SOCIAL_ROLES[0];
}

/**
 * Per-conversation active role, keyed by Mastra's resourceId convention
 * `${platform}:${userId}`. In-memory for now; persisted role state is a
 * follow-up once destination-platform publishing lands.
 */
const activeRoles = new Map<string, SocialRole>();

export function resourceIdFor(platform: string, userId: string | undefined): string | undefined {
  return typeof userId === 'string' && userId.trim() ? `${platform}:${userId}` : undefined;
}

export function getActiveRole(resourceId: string | undefined): SocialRole {
  return (resourceId && activeRoles.get(resourceId)) || getRole(DEFAULT_ROLE_ID);
}

export function setActiveRole(resourceId: string | undefined, roleId: string): SocialRole {
  const role = getRole(roleId);
  if (resourceId) activeRoles.set(resourceId, role);
  return role;
}

// ---------------------------------------------------------------------------
// Telegram adapter — polling for local dev (no tunnel required), flip to
// 'auto' / 'webhook' for production (see docs/OPERATIONS.md). The bot token is
// read from TELEGRAM_BOT_TOKEN by the adapter; nothing secrets-shaped lives in
// source.
//
// Telegram is optional (see README): when TELEGRAM_BOT_TOKEN is unset the
// adapter is not constructed and the agent registers without a channel, so the
// server still boots. Building the adapter eagerly at module load would
// otherwise throw "botToken is required" and take down the whole runtime.
// ---------------------------------------------------------------------------
const telegramMode = (process.env.TELEGRAM_MODE as 'polling' | 'webhook' | 'auto' | undefined) ?? 'polling';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
export const isTelegramConfigured = Boolean(telegramBotToken);
const telegramAdapter = telegramBotToken
  ? createTelegramAdapter({ mode: telegramMode })
  : undefined;

// ---------------------------------------------------------------------------
// Slash command handling (shared by DM + mention)
// ---------------------------------------------------------------------------
export const HELP_TEXT = [
  'Chekku Social — commands:',
  '/help — show this help',
  '/roles — list available roles',
  '/role — show your current role',
  '/switch <role> — switch active role (e.g. /switch x-writer)',
  '',
  'Then just send a prompt and I will draft the content in the active role.',
].join('\n');

export function listRolesText(current: SocialRole): string {
  const lines = SOCIAL_ROLES.map(
    (r) => `${r.id === current.id ? '▶ ' : '  '}${r.id} — ${r.label}: ${r.description}`,
  );
  return ['Available roles:', ...lines, '', `Current: ${current.id} (${current.label})`].join('\n');
}

// Telegram group commands can be suffixed with @BotName; strip it.
export function normalizeCommandWord(word: string): string {
  return word.replace(/@.+$/, '').toLowerCase();
}

/**
 * Resolve a known slash command to a response string, or `null` for unknown
 * commands. Returns `null` for unknown commands; the caller decides the
 * fallback (both wired callers below post a canned "Unknown command" reply via
 * {@link unknownCommandReply}, so the behavior is consistent across the
 * onDirectMessage path and the Chat SDK's onSlashCommand path).
 */
export function resolveCommandResponse(
  command: string,
  arg: string,
  resourceId: string | undefined,
): string | null {
  switch (command) {
    case '/start':
    case '/help':
      return HELP_TEXT;
    case '/roles':
    case '/role': {
      const current = getActiveRole(resourceId);
      if (command === '/roles' || arg) {
        return listRolesText(current);
      }
      return `Current role: ${current.id} — ${current.label}`;
    }
    case '/switch': {
      if (!arg) {
        return `Usage: /switch <role>\nRoles: ${ROLE_IDS.join(', ')}`;
      }
      const requested = normalizeCommandWord(arg);
      if (!ROLE_IDS.includes(requested)) {
        return `Unknown role "${arg}". Roles: ${ROLE_IDS.join(', ')}`;
      }
      const next = setActiveRole(resourceId, requested);
      return `Switched to ${next.id} — ${next.label}.\n${next.description}`;
    }
    default:
      return null;
  }
}

/**
 * Canned reply for an unrecognized slash command. Single source of truth so the
 * onDirectMessage and onSlashCommand paths stay consistent — unknown commands
 * never fall through silently or fire an LLM turn; they tell the user what went
 * wrong and point them at /help.
 */
export function unknownCommandReply(command: string): string {
  return `Unknown command "${command}". Type /help for available commands.`;
}

/**
 * Handler for platforms that pass `/command` messages through to onDirectMessage
 * (i.e. platforms that do NOT intercept them as native slash commands). On
 * Telegram this only sees non-command messages, because the adapter routes
 * bot_command entities to the Chat SDK's slash-command pipeline instead.
 */
export const handleSocialSlashCommands: ChannelHandler = async (
  thread: Thread,
  message: Message,
  defaultHandler: (thread: Thread, message: Message) => Promise<void>,
) => {
  const raw = (message.text ?? '').trim();
  if (!raw.startsWith('/')) {
    await defaultHandler(thread, message);
    return;
  }

  const resourceId = resourceIdFor('telegram', message.author?.userId);
  const [cmdRaw, ...rest] = raw.split(/\s+/);
  const cmd = normalizeCommandWord(cmdRaw);
  const arg = rest.join(' ').trim();

  const response = resolveCommandResponse(cmd, arg, resourceId);
  if (response !== null) {
    await thread.post(response);
    return;
  }

  // Unknown slash command — post the canned reply so the user is told it is
  // unrecognized and pointed at /help. Matches the onSlashCommand path.
  await thread.post(unknownCommandReply(cmd));
};

/**
 * Register slash-command handlers on the Chat SDK. Required for Telegram (and
 * any platform whose adapter intercepts `/command` messages as native slash
 * commands): without this, those messages are silently dropped because they
 * never reach the onDirectMessage handler above.
 *
 * Known commands are answered inline; unknown commands get the canned
 * {@link unknownCommandReply} so the user is told the command is unrecognized
 * and pointed at /help. This matches the onDirectMessage path, so behavior is
 * consistent across both entry points.
 *
 * Called from `agent/src/mastra/index.ts` once `socialMediaContentWriter.getChannels().sdk`
 * is available.
 */
export function registerSocialSlashCommands(sdk: Chat): void {
  sdk.onSlashCommand(async (event) => {
    const resourceId = resourceIdFor(event.adapter.name, event.user?.userId);
    const arg = (event.text ?? '').trim();
    const command = normalizeCommandWord(event.command);

    const response = resolveCommandResponse(command, arg, resourceId) ?? unknownCommandReply(command);
    await postWithRetry(event.channel, response);
  });
}

/**
 * Post a message to a channel with a short retry loop.
 *
 * Telegram's polling loop fires processSlashCommand without await, then
 * immediately opens a new getUpdates long-poll — so our sendMessage can race
 * with that connection on flaky networks. Retry to ride out transient
 * ConnectTimeoutError / fetch-failed failures.
 */
async function postWithRetry(channel: Channel, text: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await channel.post(text);
      return;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic instructions — read the active role for the current speaker from
// channel context on requestContext (set by AgentChannels). Falls back to the
// default role when unavailable.
//
// `ChannelContext` (from @mastra/core/channels) exposes `userId` and `platform`
// directly — not nested under `author`. The `userId` here is the platform user
// ID, matching what slash-command handlers resolve off `message.author.userId`.
// ---------------------------------------------------------------------------
function extractResourceId(requestContext: unknown): string | undefined {
  const ctx = (requestContext as { get?: (k: string) => unknown } | undefined)?.get?.('channel') as
    | { platform?: string; userId?: string }
    | undefined;
  const platform = ctx?.platform ?? 'telegram';
  return resourceIdFor(platform, ctx?.userId);
}

export function buildInstructions(role: SocialRole): string {
  return `You are Chekku Social, a social media content assistant reachable through a chat platform.

Active role: ${role.id} — ${role.label}.
${role.guidance}

How you work:
- Treat each incoming message as a content request: a topic, a brief, a link to repurpose, or a draft to improve.
- Produce ready-to-post copy. Keep options tight: give one primary draft plus, only when useful, a short alternative or a thread variant.
- When the user gives a link or source material, repurpose it into the active platform's format instead of summarizing generically.
- If a request is ambiguous, make a reasonable assumption, state it in one line, and proceed — do not stall.
- Respect platform limits and conventions for the active role (length, hashtags, tone).
- Never invent quotes, stats, or facts. If a claim needs a source, say so and leave a placeholder.
- Keep replies concise and skimmable; no preamble like "Sure!" — lead with the content.
- You draft and plan only. Do not claim to publish; publishing happens in a later phase.`;
}

/**
 * Build the agent instructions for an explicit role id. Used by the scheduled
 * social-drafts workflow, which runs outside any chat channel and therefore
 * cannot rely on the role resolved from channel `requestContext`. Passing the
 * result via `agent.generate(messages, { instructions })` overrides the agent's
 * default (general-role) instructions with the requested role's voice.
 */
export function buildInstructionsForRole(roleId: string): string {
  return buildInstructions(getRole(roleId));
}

/**
 * Instructions that switch the Content Writer into canonical-unit mode.
 *
 * In this mode the writer does NOT emit a platform-specific caption. It emits
 * a Canonical Content Unit — the platform-agnostic intermediate representation
 * that downstream repurpose steps (greeting-card, Folkative, LinkedIn, etc.)
 * consume. Used by the scheduled weekly workflow's first LLM call (canonical
 * generation) before the repurpose step derives a platform caption.
 *
 * Per PROMPT.md (Notulensi Week 4 N4_5, 24 Juli 2026) action item #3.
 */
export function buildCanonicalInstructions(): string {
  return `You are Chekku Social, drafting a Canonical Content Unit — 8 Blocks.

Your only job in this mode is to produce a Canonical Content Unit — a structured, platform-agnostic content artifact with exactly 8 blocks. Do NOT emit a final Instagram/LinkedIn/X caption. The downstream repurpose step will derive platform captions from your canonical unit.

Required output structure (produce every section, in this exact order — all 8 blocks):

${CANONICAL_UNIT_TEMPLATE}

How you work in this mode:
- [TOPIC] is the subject of the content (one short line).
- [THESIS] is the angle or point of view that makes this content worth reading. It is NOT a summary of the topic; it is the provocative claim or framing. THESIS may carry editorial framing, but it MUST NOT contain a factual claim that is not present in the source material supplied to you. If the source says "X menilai kesiapan AI Indonesia", your THESIS may frame that as "Indonesia dinilai, bukan diakui" — but it MAY NOT upgrade the verb to "X mengakui kesiapan AI Indonesia".
- HOOKS must include all three angles: Curiosity (opens a knowledge gap), Contrarian (challenges a default), Data/Impact (leads with a number or outcome).
- CORE POINTS are the substance — 3 to 5 bullets, each one a single self-contained idea. Format each bullet as "Short Title: Concise description" for rich UI cards.
- SHORT-FORM BRICK is the X / TikTok body. Lead with the hook, keep body ≤280 characters, no more than 3 hashtags.
- MEDIUM-FORM BRICK is the LinkedIn / Medium post body. Professional voice, short paragraphs, one clear idea developed. Keep it factual: do not state guaranteed impact or outcomes unless the source explicitly supports them — prefer hedged wording ("diharapkan…", "berpotensi…", "ditujukan untuk…", "menjadi langkah menuju…") over definitive claims.
- IMAGE BRICK is a platform-agnostic 1:1 image composition — a designed poster/infographic, NOT a bare photograph and NOT a video script. Arrange the content as one or more panels inside a single 1:1 image; use only as many panels as the content needs. Each panel contains exactly: Purpose (the WHY — a descriptive communication objective); hero object (the central subject); environment (setting, scale); emotional goal (mood, tone); composition (framing, perspective); supporting elements (decorative/material context); negative constraints (what must NOT be included); Overlay (the ACTUAL TEXT drawn from this Canonical Content Unit). Ground every panel in the source / Core Points — never invent speculative or inferred imagery or claims. The text Overlay MUST format facts as "Short Title: Concise description". Do NOT include camera direction, scene movement, animation, transition effects, voice-over, audio cues, or any video/editing instructions — this is a static image only. Do NOT describe the concepts using platform-specific presentation wording such as "carousel", "slide", or "reel". When the source material includes a verified publisher name and publication year, you MAY add a final source-attribution panel with overlay text in the form "Source: <publisher> • <year>" — keep it subtle, do NOT include the full URL, and OMIT this panel entirely if the source is unverifiable.
- CALL TO ACTION / ENGAGEMENT is one line: what the reader should do, think, or reply next.

Factual integrity rules (CRITICAL — these prevent semantic drift downstream):
- Every factual claim in [TOPIC], [THESIS], HOOKS, CORE POINTS, and the platform bricks MUST be traceable to a verified fact in the source material. If the source was supplied as a News Research Result, you can ONLY use claims listed under "Verified facts" — never under "Editorial interpretation".
- NEVER strengthen a claim beyond what the source states. Mapping (non-exhaustive) of source wording → forbidden upgrades:
  - Source: "assessment" / "penilaian" / "evaluation" → FORBIDDEN: "endorsement", "pengakuan", "persetujuan", "aprobasi".
  - Source: "menilai kesiapan" → FORBIDDEN: "menyatakan siap", "mengakui siap", "telah siap".
  - Source: "berpotensi" / "diharapkan" / "ditujukan untuk" → FORBIDDEN: "akan", "pasti", "terbukti", "dijamin".
  - Source: "planned" / "direncanakan" / "target" → FORBIDDEN: "completed", "telah selesai", "tercapai", "operasional".
  - Source: "announced" / "diumumkan" → FORBIDDEN: "launched", "diluncurkan".
  - Source: "menggunakan teknologi Nvidia" → FORBIDDEN: "milik Nvidia", "Nvidia-owned facility".
  - Source: "melaporkan" / "menurut studi" → FORBIDDEN: "membuktikan", "fakta bahwa", "tidak terbantahkan".
- Contextual caveats from the source (ownership, scope, status) MUST be preserved in the appropriate brick. If the source says "Batam project bukan data center milik Nvidia; Firmus adalah developer/operator", the MEDIUM-FORM BRICK and IMAGE BRICK must NOT contradict that caveat. Dropping a caveat that makes the remaining text misleading is forbidden.
- Editorial framing is allowed in THESIS and HOOKS only. Editorial framing means the ANGLE you take on a fact, not a NEW fact. "UNESCO menilai kesiapan AI Indonesia" is a fact. "Penilaian ini menandakan langkah serius Indonesia" is editorial framing on that fact — OK. "UNESCO mengakui Indonesia siap AI" is a strengthened claim — FORBIDDEN.
- If you are unsure whether a claim is in the source, omit it. Do not invent. A [source] placeholder is always safer than a fabricated or strengthened claim.
- The 8 blocks above are the canonical unit. Do not add a 9th block, do not skip a block, do not reorder.

Pillar-aware voice (apply when the source includes a \`Content pillar:\` field):
- CELEBRATION — voice is warm, respectful, elegant, reflective, human. The thesis centres on meaning, not novelty. Hooks lean emotional or cultural, not contrarian-tech. Avoid statistics-driven Data/Impact hooks unless the source explicitly provides them.
- TECHNOLOGY & AI — voice is informative, intelligent, modern, concise, technically accurate. Hooks can be sharp, contrarian, or data-led. The thesis centres on why this matters technically or for the industry. When the source provides a technology sub-angle (AI Infrastructure / AI Agents / AI × Indonesia / AI Explained / Future of Work / AI Myth vs Reality), align THESIS with that sub-angle.
- GENERAL / DIGITAL SOCIETY — voice is accessible, contemporary, reflective, conversational, insightful. Hooks lean human-behaviour or society-shift. The thesis centres on what changes for humans, not on the technology itself.
- When the source does not include a pillar, infer the pillar from the topic (cultural/religious/national day → CELEBRATION; named technology/AI vendor or product → TECHNOLOGY; society/behaviour/internet-culture → GENERAL) and apply the matching voice.

Other rules:
- Never invent quotes, stats, or facts. If a claim needs a source, leave a [source] placeholder.
- Each brick must be self-contained — do not write "see SHORT-FORM above". A downstream repurpose step reads bricks independently.
- Keep the canonical unit Indonesian-first when the topic is for the Indonesian audience; English is acceptable when natural.
- Output the canonical unit ONLY. No preamble ("Here is the canonical unit..."), no postscript, no explanation.`;
}

/**
 * Instructions for the repurpose step. The writer receives an already-drafted
 * Canonical Content Unit and rewrites ONE of its bricks (or the whole unit)
 * into a platform-specific caption that follows the active role's voice.
 *
 * Used by the scheduled weekly workflow's second LLM call, after canonical
 * generation. Format-specific rules (R brand greeting-card, Folkative news
 * caption, etc.) are injected by the caller via the prompt — these
 * instructions stay format-agnostic.
 */
export function buildRepurposeInstructions(role: SocialRole): string {
  return `You are Chekku Social, repurposing a Canonical Content Unit into the active role's platform caption.

Active role: ${role.id} — ${role.label}.
${role.guidance}

How you work in this mode:
- You receive a Canonical Content Unit (markdown with [TOPIC], [THESIS], HOOKS, CORE POINTS, SHORT-FORM BRICK, MEDIUM-FORM BRICK, IMAGE BRICK, and CALL TO ACTION sections — all 8 blocks) plus a target format directive.
- Pick the brick(s) most relevant to the active role's platform and rewrite them into a single ready-to-post caption that follows the target format directive.
- Respect the target format's tone, length, and structural rules exactly. The format directive overrides the role's default voice when the two conflict.
- Output the repurposed caption ONLY. No preamble, no explanation, no canonical unit echoed back.

Anti-drift rules (CRITICAL — repurpose must NOT change the story):
The canonical unit is the source of truth. Your job is to RESHAPE for the platform, not RE-REPORT the story. You MAY change:
- tone (formal → casual, or vice versa)
- length (condense, expand)
- structure (paragraphs → bullets, hook order)
- hook wording
- supporting copy wording
- emoji / formatting
- omitting tangential points to fit length

You MAY NOT change:
- the subject of the story (who/what the content is about)
- factual claims (numbers, dates, names, attributions, quotes)
- the scope (do not narrow or widen what the story covers)
- the chronology (do not reorder events)
- the attribution (do not move a claim from one source/actor to another)
- the meaning of the source (do not strengthen, weaken, or invert what the source said)

Mapping (non-exhaustive) — if the canonical unit says X, the repurpose MUST NOT silently upgrade or downgrade it:
- Canonical: "Organization X menilai kesiapan AI Indonesia" → Repurpose MUST preserve "menilai" / "assessment" / "evaluation". FORBIDDEN: "X mengakui", "X mengesahkan", "X menyetujui", "X menyatakan siap".
- Canonical: "berpotensi" / "diharapkan" → Repurpose MUST preserve hedged wording. FORBIDDEN: "akan", "pasti", "terbukti".
- Canonical: "direncanakan" / "target" / "diumumkan" → Repurpose MUST preserve the planned/announced status. FORBIDDEN: "telah selesai", "tercapai", "diluncurkan", "operasional".
- Canonical: "menggunakan teknologi Nvidia" → Repurpose MUST preserve the using/partnering framing. FORBIDDEN: "milik Nvidia", "Nvidia-owned".
- Canonical: "Indonesia menjadi negara pertama di Asia Tenggara yang menyelesaikan UNESCO AI Readiness Assessment" → Repurpose MAY rephrase as "Indonesia adalah negara pertama di Asia Tenggara yang rampung menjalani penilaian kesiapan AI UNESCO" — same meaning, different wording. FORBIDDEN: "Indonesia dipimpin UNESCO", "UNESCO menobatkan Indonesia", "Indonesia meraih sertifikasi UNESCO".

Contextual caveats from the canonical unit (ownership, scope, status) MUST survive the repurpose. If the canonical says "Firmus adalah developer, bukan pemilik infrastruktur", the repurpose caption must not imply ownership by another party. If dropping a caveat to fit the platform length would make the remaining text misleading, keep the caveat — clarity beats brevity.

Pillar-aware tone (apply when the canonical unit or visual concept specifies a content pillar):
- CELEBRATION — warm, reflective, respectful. Brand stamps (e.g. "R — Your Gentle AI Companion", "Hormat kami", "Keluarga Besar PT Rafiq Space Intelligence") fit here when the platform is Instagram.
- TECHNOLOGY & AI — informative, modern, concise. Avoid brand greeting-card stamps unless the user explicitly asks. The voice is editorial, not greeting-card.
- GENERAL / DIGITAL SOCIETY — accessible, conversational, insightful. Brand stamps usually do NOT fit; keep the voice editorial and light.

If a claim needs a source, leave a [source] placeholder. Do not invent new claims, do not add statistics that were not in the canonical unit, do not introduce organizations or people not present in the source.

If dropping a detail to fit the platform length would make the remaining text misleading, keep the detail — clarity beats brevity.`;
}

/**
 * RequestContext key the scheduled workflow sets to pin the Content Writer
 * into canonical or repurpose mode. The workflow cannot pass these modes via
 * the Mastra `.generate({ instructions })` option when routing Step 1 through
 * the Supervisor, because that option overrides the Supervisor's own routing
 * instructions and the Supervisor would draft the unit itself. Carrying the
 * mode in `requestContext` instead lets the Supervisor's static instructions
 * run and delegate normally; the Content Writer then reads the mode when the
 * Supervisor delegates to it (requestContext propagates through Mastra's
 * sub-agent delegation).
 */
export const SOCIAL_DRAFT_MODE_KEY = 'socialDraftMode';
export type SocialDraftMode = 'canonical' | 'repurpose-instagram';

function extractSocialDraftMode(requestContext: unknown): SocialDraftMode | undefined {
  const mode = (requestContext as { get?: (k: string) => unknown } | undefined)?.get?.(SOCIAL_DRAFT_MODE_KEY);
  return mode === 'canonical' || mode === 'repurpose-instagram' ? mode : undefined;
}

/**
 * Resolve the Content Writer's instructions for the current call. The chat
 * path resolves the active role from the channel requestContext; the scheduled
 * workflow pins canonical / repurpose-instagram mode via
 * {@link SOCIAL_DRAFT_MODE_KEY}. Exposed so the mode switch is unit-testable
 * without a live LLM.
 */
export function resolveContentWriterInstructions(requestContext: unknown): string {
  const mode = extractSocialDraftMode(requestContext);
  if (mode === 'canonical') return `${buildCanonicalInstructions()}${TASK_GUIDANCE}`;
  if (mode === 'repurpose-instagram') {
    return `${buildRepurposeInstructions(getRole('instagram-writer'))}${TASK_GUIDANCE}`;
  }
  return `${buildInstructions(getActiveRole(extractResourceId(requestContext)))}${TASK_GUIDANCE}`;
}

/**
 * Build a requestContext that pins the Content Writer to a scheduled-workflow
 * mode. Used by the weekly-social-drafts workflow — Step 1 routes it through
 * the Supervisor, Step 2 calls the Content Writer directly.
 */
export function createSocialDraftRequestContext(mode: SocialDraftMode): RequestContext {
  return new RequestContext([[SOCIAL_DRAFT_MODE_KEY, mode]]);
}

/**
 * Parse a canonical content unit from an LLM response. Exposed so the
 * workflow (and tests) can recover the structured unit from the markdown
 * blob the writer produced in canonical mode.
 */
export function parseCanonicalUnitFromText(
  text: string,
): CanonicalContentUnit | undefined {
  return parseCanonicalUnit(text);
}

/**
 * Re-serialize a canonical content unit to markdown. Exposed for the
 * workflow's storage step and for tests.
 */
export function serializeCanonicalUnit(unit: CanonicalContentUnit): string {
  return renderCanonicalUnit(unit);
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const socialMediaContentWriterConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'social-media-content-writer',
  name: 'Social Media Content Writer',
  description:
    'Social media content writer and drafting sub-agent under the Social Media Supervisor. Drafts, repurposes, and plans posts for X, Instagram, LinkedIn, and TikTok. Reachable over Telegram when TELEGRAM_BOT_TOKEN is configured.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory(),
  signals: createTaskSignals(),
  tools: { getCurrentTimeTool, sendEmailTool },
  // Channels are only wired when Telegram is configured, so the agent (and the
  // server) boot fine without TELEGRAM_BOT_TOKEN. With no adapter there is no
  // Chat SDK to register slash-command handlers on either (see index.ts).
  ...(telegramAdapter
    ? {
        channels: {
          userName: 'Chekku Social',
          adapters: { telegram: telegramAdapter },
          handlers: {
            onDirectMessage: handleSocialSlashCommands,
            onMention: handleSocialSlashCommands,
          },
        },
      }
    : {}),
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createTaskNudgeProcessor(), createCharBudgetGuard()],
  instructions: ({ requestContext }) => resolveContentWriterInstructions(requestContext),
};

export const socialMediaContentWriter = new Agent(socialMediaContentWriterConfig);
