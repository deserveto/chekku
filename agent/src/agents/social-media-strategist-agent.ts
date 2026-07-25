import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { searchWebTool } from '../mastra/tools/searxng-search.js';
import { readWebPageTool } from '../mastra/tools/web-reader.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

export const SOCIAL_MEDIA_STRATEGIST_AGENT_ID = 'social-media-strategist-agent';

const PLACEHOLDER_INSTRUCTIONS = `You are Social Media Strategist.`;

const socialMediaStrategistAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: SOCIAL_MEDIA_STRATEGIST_AGENT_ID,
  name: 'Social Media Strategist',
  description:
    'Interviews the user, performs optional web research, drafts a Content Strategy Brief for any brand or product, refines it on review, and (after approval) produces a Content Plan grounded in that brief.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  memory: createAgentMemory(),
  inputProcessors: [createAgentContextLimiter(), createCharBudgetGuard()],
  tools: {
    search_web: searchWebTool,
    read_web_page: readWebPageTool,
  },
  defaultOptions: { maxSteps: 12 },
  instructions: PLACEHOLDER_INSTRUCTIONS,
};

export const socialMediaStrategistAgent = new Agent(socialMediaStrategistAgentConfig);
