import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { providerContextSchema, type ProviderContext } from './context.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { createTaskNudgeProcessor } from '../mastra/tasks/task-nudge-processor.js';
import { TASK_GUIDANCE, createTaskSignals } from '../mastra/tasks/task-signals.js';
import { getServerModel } from '../providers/model.js';

const mainAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'main-agent',
  name: 'Chekku Assistant',
  description: 'A general-purpose AI assistant for everyday tasks.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory({ generateTitle: true }),
  signals: createTaskSignals(),
  inputProcessors: [createAgentContextLimiter(), createTaskNudgeProcessor(), createCharBudgetGuard()],
  instructions: `You are Chekku Assistant, a general-purpose AI assistant inside Chekku.
Help users understand information, answer questions, draft content, reason through problems, and assist with everyday tasks.
Be clear, accurate, and practical. Ask for clarification only when the request cannot be completed safely or correctly without it.
Do not claim to browse websites, operate a browser, inspect applications, or perform QA testing unless the required registered tools are explicitly available.
For browser-based website testing, direct users to the QA Web Agent rather than pretending to perform browser actions.
Do not act as a supervisor or delegate work to other agents in this version.${TASK_GUIDANCE}`,
};

export const mainAgent = new Agent(mainAgentConfig);

/**
 * Durable rollout (Task D, Fase 1): the general-purpose assistant runs
 * through `createDurableAgent` for a uniform runtime across the studio —
 * same contract as `durablePmAgent` (in-process PubSub, no Redis, public
 * id stays `main-agent`, composition key stays `mainAgent`, `/runs`
 * surface unchanged, `cleanup()` on terminal states, crash recovery not
 * available in the pinned `@mastra/core` 1.50.1). Its only caller is the
 * chat run surface.
 */
export const durableMainAgent = createDurableAgent({
  agent: mainAgent as Agent<string, ToolsInput, undefined>,
});
