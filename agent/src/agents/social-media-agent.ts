import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import type { ChannelHandler } from '@mastra/core/channels';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import type { Channel, Chat, Message, Thread } from 'chat';
import { Memory } from '@mastra/memory';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { sendEmailTool } from '../mastra/tools/send-email.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

/**
 * Social Media Agent
 *
 * A generic, role-switchable social media assistant exposed over a Mastra
 * channel (Telegram today, other platforms later). Users drive it from a chat
 * platform: they ask it to draft / repurpose / schedule posts, and switch the
 * active "role" to tune voice for a specific platform via slash commands
 * (`/switch`, `/roles`, `/role`, `/help`).
 *
 * Phase scope: the agent drafts and plans posts inside the chat. Actual
 * publishing to destination platforms is a later phase.
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
    description: 'Scroll-stopping hooks, caption structure, and hashtag sets.',
    guidance:
      'Write for Instagram. Open with a scroll-stopping first line, use line breaks for readability, pair an engaging caption with a clear CTA, and end with a targeted hashtag set (mix broad and niche). Suggest a visual direction in one line.',
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
 * Called from `agent/src/mastra/index.ts` once `socialMediaAgent.getChannels().sdk`
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

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const socialMediaAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'social-media-agent',
  name: 'Chekku Social',
  description:
    'Generic, role-switchable social media assistant. Drafts, repurposes, and plans posts for X, Instagram, LinkedIn, and TikTok. Reachable over Telegram when TELEGRAM_BOT_TOKEN is configured.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: new Memory(),
  // No per-tool approval gate: sendEmailTool runs autonomously. The agent is
  // intended to run unattended (e.g. over Telegram), so the previous
  // Approve/Decline gate on outbound email was intentionally dropped. Broader
  // human-in-the-loop gates will be added later as a dedicated layer.
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
  inputProcessors: [gatewayCompatibilityProcessor],
  instructions: ({ requestContext }) =>
    buildInstructions(getActiveRole(extractResourceId(requestContext))),
};

export const socialMediaAgent = new Agent(socialMediaAgentConfig);
