import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';
import { socialMediaContentWriter } from './social-media-content-writer.js';

/**
 * Social Media Supervisor
 *
 * The routing agent that owns the social-media surface and delegates drafting
 * work to its sub-agents. It has no tools of its own — per the supervisor
 * architecture, it only routes incoming requests to the right sub-agent
 * (Content Writer today; Strategist in a later phase).
 *
 * Routing is exercised via Mastra's `agents` sub-agent field, which exposes
 * each sub-agent as a delegation primitive the supervisor can invoke through
 * its network loop. Active call paths (chat UI, future integrations) opt into
 * routing by calling the supervisor; the Telegram channel stays on the
 * Content Writer for this refactor per the meeting brief.
 *
 * The supervisor still binds Memory and the same context-safety processors as
 * the other code-defined agents so its own turns cannot overflow the model
 * window, even though it performs no tool calls.
 */

const socialMediaSupervisorAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'social-media-supervisor-agent',
  name: 'Social Media Supervisor',
  description:
    'Supervisor for the social-media surface. Receives user requests and delegates drafting and planning work to the Content Writer sub-agent (and future sub-agents). Has no tools of its own; it only routes.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory(),
  // Supervisor has no tools — per the supervisor architecture it only routes
  // to sub-agents via the `agents` field below.
  agents: {
    socialMediaContentWriter,
  },
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  instructions: `You are the Social Media Supervisor, the routing agent for Chekku's social-media surface.

Your only job is to delegate each incoming request to the right sub-agent. You do not draft, repurpose, or plan content yourself — you have no content tools.

How you work:
- The "Social Media Content Writer" sub-agent drafts, repurposes, and plans posts for X, Instagram, LinkedIn, and TikTok. Delegate every content drafting, rewriting, repurposing, or platform-formatting request to it.
- Forward the user's intent and any source material (links, briefs, drafts) to the sub-agent unchanged. Do not paraphrase the request before delegating.
- Return the sub-agent's drafted content to the user without reformatting, summarizing, or adding your own preamble.
- If a request is clearly out of social-media scope, say so in one short line and suggest the right Chekku agent. Do not invent capabilities.
- Keep replies concise and skimmable; no preamble like "Sure!" — lead with the delegated result.
- You plan and route only. Do not claim to publish; publishing happens in a later phase.`,
};

export const socialMediaSupervisorAgent = new Agent(socialMediaSupervisorAgentConfig);
