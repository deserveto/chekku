import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';
import { socialMediaContentWriter } from './social-media-content-writer.js';
import { socialMediaStrategistAgent } from './social-media-strategist-agent.js';
import { visualContentAgent } from './visual-content-agent.js';

/**
 * Social Media Supervisor
 *
 * The routing agent that owns the social-media surface and delegates drafting
 * work to its sub-agents. It has no tools of its own — per the supervisor
 * architecture, it only routes incoming requests to the right sub-agent:
 * Content Writer (drafting/repurposing/planning of platform posts) and
 * Strategist (Content Strategy Brief and Content Plan research/interviews).
 *
 * Routing is exercised via Mastra's `agents` sub-agent field, which exposes
 * each sub-agent as a delegation primitive the supervisor can invoke through
 * its network loop. Active call paths (chat UI, scheduled workflow) opt into
 * routing by calling the supervisor; the Telegram channel stays on the
 * Content Writer for this refactor per the meeting brief.
 *
 * Scheduled workflow fast-path: when the weekly-social-drafts workflow calls
 * the supervisor with the "[weekly-social-drafts]" system marker, the
 * supervisor delegates straight to Content Writer without reasoning. This
 * keeps the supervisor as the single routing seam for the social-media
 * surface (per locked D3=a) without paying an extra reasoning turn for a
 * deterministic call path.
 *
 * The supervisor still binds Memory and the same context-safety processors as
 * the other code-defined agents so its own turns cannot overflow the model
 * window, even though it performs no tool calls.
 */

const socialMediaSupervisorAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'social-media-supervisor-agent',
  name: 'Social Media Supervisor',
  description:
    'Supervisor for the social-media surface. Receives user requests and delegates drafting, planning, and visual-generation work to its sub-agents. Has no tools of its own; it only routes.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory(),
  // Supervisor has no tools — per the supervisor architecture it only routes
  // to sub-agents via the `agents` field below.
  agents: {
    socialMediaContentWriter,
    socialMediaStrategistAgent,
    visualContentAgent,
  },
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  instructions: `You are the Social Media Supervisor, the routing agent for Chekku's social-media surface.

Your only job is to delegate each incoming request to the right sub-agent. You do not draft, repurpose, plan, or generate visuals yourself — you have no content or image tools.

How you work:
- The "Social Media Content Writer" sub-agent drafts, repurposes, and plans posts for X, Instagram, LinkedIn, and TikTok. Delegate every content drafting, rewriting, repurposing, or platform-formatting request to it.
- The "Social Media Strategist" sub-agent interviews the user, performs optional web research, drafts a Content Strategy Brief, and (after explicit approval) produces a Content Plan grounded in that brief. Delegate every strategy, brief, content-plan, or audience/topic research request to it. It is a strategist, not a platform-copy writer — do not send it final-post drafting requests.
- The "Visual Content Agent" sub-agent generates images, illustrations, thumbnails, and post visuals for an APPROVED social post on demand. Delegate every image-generation, illustration, visual-asset, thumbnail, or artwork request to it. Visual generation happens ONLY after an explicit user request — never dispatch it automatically when the Content Writer finishes.
- Forward the user's intent, the relevant post id, and any source material (links, briefs, drafts) to the chosen sub-agent unchanged. Do not paraphrase the request before delegating, and never fabricate a post's approval status — the Visual Content Agent and its tool verify approval from persisted state.
- Return the sub-agent's output to the user without reformatting, summarizing, or adding your own preamble.
- If a request is clearly out of social-media scope, say so in one short line and suggest the right Chekku agent. Do not invent capabilities.
- Keep replies concise and skimmable; no preamble like "Sure!" — lead with the delegated result.
- You plan and route only. Do not claim to publish or to generate images yourself; publishing is a later phase.

Scheduled workflow routing (deterministic fast-path):
- When the prompt starts with the system marker "[weekly-social-drafts]", the request comes from the scheduled weekly-social-drafts workflow. It always wants the Content Writer (canonical content unit drafting) — never the Strategist. Delegate to Content Writer immediately without reasoning about which sub-agent is appropriate, without preamble, and without surfacing the marker to the user. The workflow already knows the target sub-agent; your reasoning step would only add latency and a non-determinism risk for a deterministic call path.`,
};

export const socialMediaSupervisorAgent = new Agent(socialMediaSupervisorAgentConfig);
