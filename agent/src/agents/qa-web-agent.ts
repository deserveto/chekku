import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { browser } from '../mastra/browsers.js';
import { createDescriptionForwardingDurableAgent } from '../mastra/durable-agent.js';
import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { createTaskNudgeProcessor } from '../mastra/tasks/task-nudge-processor.js';
import { TASK_GUIDANCE, createTaskSignals } from '../mastra/tasks/task-signals.js';
import { calculatorTool } from '../mastra/tools/calculator.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

const qaWebAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'qa-web-agent',
  name: 'QA Web Agent',
  description:
    'Completes browser-based QA and web interaction tasks, then returns concise findings, evidence, and blockers. Use when a task requires navigating or interacting with a live website.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  browser,
  tools: { calculatorTool, getCurrentTimeTool },
  signals: createTaskSignals(),
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createTaskNudgeProcessor(), createCharBudgetGuard()],
  memory: createAgentMemory({ generateTitle: true }),
  defaultOptions: () => ({ maxSteps: 80 }),
  instructions: `You are QA Web Agent, a careful browser QA delegate.

Complete the assigned browser or website task, then return distilled findings, evidence, and blockers to the parent agent. Use browser tools only when live navigation or interaction is required. Do not greet or add progress narration.

Never expose secrets or credentials. If a site blocks automation or needs user authentication, state that plainly and return the safest next step.${TASK_GUIDANCE}`,
};

export const qaWebAgent = new Agent(qaWebAgentConfig);

/**
 * Durable rollout (Task D, Fase 1): the QA Web Agent runs the studio's
 * longest interactive jobs (`maxSteps: 80` browser sessions), so it runs
 * through `createDescriptionForwardingDurableAgent` alongside the pm-agent
 * pilot. Same contract
 * as `durablePmAgent`: in-process PubSub and in-memory event cache (no
 * Redis), public id stays `qa-web-agent` and the composition key stays
 * `qaWebAgent`, so `getAgentById`, thread-id ownership, and the `/runs`
 * surface are unchanged. Stop flows through the run registry's
 * AbortController; the execution driver calls `cleanup()` on terminal
 * states. Known engine limitation (pinned `@mastra/core` 1.50.1): an
 * in-flight browser action is not interrupted by the abort signal — it
 * runs to completion and the abort lands at the next LLM step; the client
 * compensates by flipping running tool cards to `interrupted` on stop.
 * Crash recovery is not available in this version. No workflow or channel
 * calls this agent directly — the chat run surface is its only caller.
 */
export const durableQaWebAgent = createDescriptionForwardingDurableAgent({
  agent: qaWebAgent as Agent<string, ToolsInput, undefined>,
});
