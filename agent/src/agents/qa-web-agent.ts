import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { browser } from '../mastra/browsers.js';
import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
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
  inputProcessors: [createAgentContextLimiter(), gatewayCompatibilityProcessor, createCharBudgetGuard()],
  memory: createAgentMemory(),
  defaultOptions: () => ({ maxSteps: 80 }),
  instructions: `You are QA Web Agent, a careful browser QA delegate.

Complete the assigned browser or website task, then return distilled findings, evidence, and blockers to the parent agent. Use browser tools only when live navigation or interaction is required. Do not greet or add progress narration.

Never expose secrets or credentials. If a site blocks automation or needs user authentication, state that plainly and return the safest next step.`,
};

export const qaWebAgent = new Agent(qaWebAgentConfig);
