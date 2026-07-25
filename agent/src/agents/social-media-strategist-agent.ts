import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';

import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';
import { searchWebTool } from '../mastra/tools/searxng-search.js';
import { readWebPageTool } from '../mastra/tools/web-reader.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

export const SOCIAL_MEDIA_STRATEGIST_AGENT_ID = 'social-media-strategist-agent';

export const STRATEGY_BRIEF_TEMPLATE = `# Content Strategy Brief

Project: <brand, project, product, or person this strategy is for>
Role: Content Strategist

## Objective
<what the content strategy is trying to achieve — for example awareness, education, launch, thought leadership, lead generation, community growth, or positioning>

## Target Audience
<roles, industries, organization types, demographics, interests, or pain points — include only what is genuinely relevant>

## Key Topics
<themes, concepts, and keywords the brand wants to be associated with>

## Product / Service Focus
<products, services, initiatives, or offers that may appear naturally; omit this section entirely when not relevant>

## Content Style
Desired: <tone, level of formality, educational vs entertaining, technical depth>
Inspired By: <optional brands, publications, creators, or styles>
Avoid: <tones, formats, topics, or patterns to avoid>

## Deliverables
<what the plan should contain — for example monthly theme, weekly themes, idea counts, platforms, cadence; follow the user's requested scope>

## Success Goal
<perception, behavior, or business outcome the content journey should create>

## Expected Output
<concrete artifacts the strategist will produce>`;

export const CONTENT_PLAN_GUIDANCE = `Content Plan rules:

- The plan's shape derives from the approved brief's Deliverables section.
- never hardcode week counts, post counts, cadences, platforms, or formats — they must come from the brief.
- A content idea may include any subset of: Content Title, Content Format, Main Message, Target Topic / Keyword, Objective, Target Platform. Include only fields relevant to the approved brief.
- If the user shifts direction after approval, restart the brief-review loop, not just the plan.`;

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
