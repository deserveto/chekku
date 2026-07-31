import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import type { ChannelHandler } from '@mastra/core/channels';
import { RequestContext } from '@mastra/core/request-context';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Channel, Chat, Message, Thread } from 'chat';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
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
  return `You are Chekku Social, drafting a Canonical Content Unit.

Your only job in this mode is to produce a Canonical Content Unit — a structured, platform-agnostic content artifact. Do NOT emit a final Instagram/LinkedIn/X caption. The downstream repurpose step will derive platform captions from your canonical unit.

Required output structure (produce every section, in this exact order):

${CANONICAL_UNIT_TEMPLATE}

How you work in this mode:
- [TOPIC] is the subject of the content (one short line).
- [THESIS] is the angle or point of view that makes this content worth reading. It is NOT a summary of the topic; it is the provocative claim or framing.
- HOOKS must include all three angles: Curiosity (opens a knowledge gap), Contrarian (challenges a default), Data/Impact (leads with a number or outcome).
- CORE POINTS are the substance — 3 to 5 bullets, each one a single self-contained idea.
- SHORT-FORM BRICK is the X / TikTok body. Lead with the hook, keep body ≤280 characters, no more than 3 hashtags.
- MEDIUM-FORM BRICK is the LinkedIn / Medium post body. Professional voice, short paragraphs, one clear idea developed. Keep it factual: do not state guaranteed impact or outcomes unless the source explicitly supports them — prefer hedged wording ("diharapkan…", "berpotensi…", "ditujukan untuk…", "menjadi langkah menuju…") over definitive claims.
- VISUAL / VIDEO SCRIPT BRICK is a platform-agnostic sequence of reusable visual concepts — NOT a finalized platform-specific layout. Do NOT label items "Panel 1 / Panel 2 / …"; write a flowing sequence of visual concepts arranged as a coherent story (Problem if applicable → key event or innovation → impact or recognition → future implication only if supported by the content). Use only the minimum number of concepts needed (simple news ≈ 3, medium topic ≈ 4, complex educational topic ≈ 5+ only when necessary; fewer or more allowed when justified); never split one idea across multiple concepts when one concept can carry it. Each concept contains exactly three elements and nothing else: Purpose (the WHY — a descriptive communication objective, e.g. "Highlight the healthcare accessibility problem", "Introduce the Home Care innovation", "Show government recognition", "Explain the national impact", "Present the future direction"; never generic labels such as "Introduction", "Core News", "Future Outlook", or "Closing"); Visual (prioritize concrete scenes of the real event, action, or situation — healthcare workers visiting a patient's home, a patient receiving treatment at home, medical staff interacting with families, community healthcare activities; do NOT default to symbolic assets like logos, maps, icons, or abstract graphics unless they are truly the central subject of the news); Overlay (short and memorable, 3–8 words, max ~10, never a full sentence — e.g. "Home Care Jemput Bola", "Diapresiasi Kemenkes RI", "Menuju Model Nasional"). Ground every visual in the source / Core Points — never invent speculative or inferred imagery (if the source only mentions international healthcare cooperation, draw "illustration of international healthcare collaboration", not "futuristic telemedicine UI"). Do NOT include camera direction, scene movement, animation, transition effects, voice-over, audio cues, or editing instructions, and do NOT describe the concepts using platform-specific presentation wording such as "carousel", "slide", or "reel" — downstream platform-specific agents decide how many cards are needed and how they are presented.
- CALL TO ACTION / ENGAGEMENT is one line: what the reader should do, think, or reply next.

Rules:
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
- You receive a Canonical Content Unit (markdown with [TOPIC], [THESIS], HOOKS, CORE POINTS, SHORT-FORM BRICK, MEDIUM-FORM BRICK, VISUAL / VIDEO SCRIPT BRICK, and CALL TO ACTION sections) plus a target format directive.
- Pick the brick(s) most relevant to the active role's platform and rewrite them into a single ready-to-post caption that follows the target format directive.
- Preserve the canonical unit's thesis and core points. Do not invent new claims; if a fact needs a source, leave a [source] placeholder.
- Respect the target format's tone, length, and structural rules exactly. The format directive overrides the role's default voice when the two conflict.
 - Output the repurposed caption ONLY. No preamble, no explanation, no canonical unit echoed back.`;
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
  if (mode === 'canonical') return buildCanonicalInstructions();
  if (mode === 'repurpose-instagram') return buildRepurposeInstructions(getRole('instagram-writer'));
  return buildInstructions(getActiveRole(extractResourceId(requestContext)));
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
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  instructions: ({ requestContext }) => resolveContentWriterInstructions(requestContext),
};

export const socialMediaContentWriter = new Agent(socialMediaContentWriterConfig);
