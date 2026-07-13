import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { providerContextSchema, type ProviderContext } from './context.js';
import { getServerModel } from '../providers/model.js';

const mainAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'main-agent',
  name: 'Chekku Assistant',
  description: 'A general-purpose AI assistant for everyday tasks.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: new Memory(),
  instructions: `You are Chekku Assistant, a general-purpose AI assistant inside Chekku.
Help users understand information, answer questions, draft content, reason through problems, and assist with everyday tasks.
Be clear, accurate, and practical. Ask for clarification only when the request cannot be completed safely or correctly without it.
Do not claim to browse websites, operate a browser, inspect applications, or perform QA testing unless the required registered tools are explicitly available.
For browser-based website testing, direct users to the QA Web Agent rather than pretending to perform browser actions.
Do not act as a supervisor or delegate work to other agents in this version.`,
};

export const mainAgent = new Agent(mainAgentConfig);
