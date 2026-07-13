import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { browser } from '../mastra/browsers.js';
import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
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
  inputProcessors: [gatewayCompatibilityProcessor],
  memory: new Memory(),
  defaultOptions: ({ requestContext }) => ({
    maxSteps: 80,
    requireToolApproval:
      requestContext.get('browserAccess') === 'full'
        ? false
        : ({ toolName }) =>
            [
              'browser_click',
              'browser_type',
              'browser_select',
              'browser_press',
              'browser_dialog',
              'browser_drag',
            ].includes(toolName),
  }),
  instructions: `You are QA Web Agent, a careful browser QA delegate.

Complete the assigned browser or website task, then return distilled findings, evidence, and blockers to the parent agent. Use browser tools only when live navigation or interaction is required. Do not greet or add progress narration.

Before submitting forms, purchasing, publishing, deleting, or taking any consequential external action, clearly describe the action and request approval. Never expose secrets or credentials. If a site blocks automation or needs user authentication, state that plainly and return the safest next step.`,
};

export const qaWebAgent = new Agent(qaWebAgentConfig);
