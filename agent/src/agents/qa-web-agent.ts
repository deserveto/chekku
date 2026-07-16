import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { browser } from '../mastra/browsers.js';
import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { calculatorTool } from '../mastra/tools/calculator.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';

// Browser interaction tools gated by the per-session access mode selected in
// the studio ('approval' asks first; 'full' runs without approval). Other
// registered tools (calculator, current-time) run freely.
const QA_WEB_APPROVAL_BROWSER_TOOLS = [
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_dialog',
  'browser_drag',
] as const;

/**
 * Decide whether a QA Web Agent tool call must be approved before it runs.
 *
 * Browser interaction tools follow the per-session access mode selected in the
 * studio: 'approval' asks first; 'full' runs without approval; when no mode is
 * set, browser tools default to gated. Everything else (e.g. calculator,
 * current-time) runs freely.
 *
 * Note: `toolName` is the tool's registration key in the agent's `tools` map,
 * not the tool's `id` field. Mastra looks tools up by that key, so the approval
 * gate must match the key.
 */
export function shouldApproveQaWebTool(browserAccess: unknown, toolName: string): boolean {
  if (browserAccess === 'full') return false;
  return (QA_WEB_APPROVAL_BROWSER_TOOLS as readonly string[]).includes(toolName);
}

const qaWebAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'qa-web-agent',
  name: 'QA Web Agent',
  description:
    'Completes browser-based QA and web interaction tasks, then returns concise findings, evidence, and blockers. Use when a task requires navigating or interacting with a live website.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  browser,
  tools: { calculatorTool, getCurrentTimeTool },
  inputProcessors: [gatewayCompatibilityProcessor],
  memory: new Memory(),
  defaultOptions: ({ requestContext }) => ({
    maxSteps: 80,
    requireToolApproval: ({ toolName }) =>
      shouldApproveQaWebTool(requestContext.get('browserAccess'), toolName),
  }),
  instructions: `You are QA Web Agent, a careful browser QA delegate.

Complete the assigned browser or website task, then return distilled findings, evidence, and blockers to the parent agent. Use browser tools only when live navigation or interaction is required. Do not greet or add progress narration.

Before submitting forms, purchasing, publishing, deleting, or taking any consequential external action, clearly describe the action and request approval. Never expose secrets or credentials. If a site blocks automation or needs user authentication, state that plainly and return the safest next step.`,
};

export const qaWebAgent = new Agent(qaWebAgentConfig);
