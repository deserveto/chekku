import { createLazyGarageObjectStorage, type ObjectStorage } from '@chekku/storage';
import type { ToolsInput } from '@mastra/core/agent';
import {
  MASTRA_TOOL_MARKER,
  Tool,
  noopObserve,
  type InternalCoreTool,
  type MastraToolInvocationOptions,
  type ToolExecutionContext,
} from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';

import {
  createCreateTextObjectTool,
  createDeleteObjectTool,
  createGetTextObjectTool,
  createListTextObjectsTool,
  createReplaceTextObjectTool,
} from '../tools/garage-object-tools.js';

type AgentExecutionContext = ToolExecutionContext & {
  agent: NonNullable<ToolExecutionContext['agent']>;
};

function hasAgentContext(
  context: ToolExecutionContext | MastraToolInvocationOptions,
): context is AgentExecutionContext {
  return 'agent' in context && context.agent !== undefined;
}

function normalizeToolContext(
  context: ToolExecutionContext | MastraToolInvocationOptions,
): ToolExecutionContext {
  if (hasAgentContext(context)) return context;
  return {
    requestContext: context.requestContext,
    abortSignal: context.abortSignal,
    actor: context.actor,
    workspace: context.workspace,
    mcp: context.mcp,
    observe: context.observe ?? noopObserve,
  };
}

function preserveAgentContext(tool: Tool, converted: InternalCoreTool): InternalCoreTool {
  const execute = async (
    input: unknown,
    context: ToolExecutionContext | MastraToolInvocationOptions,
  ): Promise<unknown> => tool.execute?.(input, normalizeToolContext(context));

  const contextPreservingTool = {
    ...converted,
    [MASTRA_TOOL_MARKER]: true,
    type: 'function' as const,
    id: tool.id,
    inputSchema: tool.inputSchema,
    requestContextSchema: tool.requestContextSchema,
    requireApproval: tool.requireApproval,
    needsApprovalFn: tool.needsApprovalFn,
    execute,
  };

  return contextPreservingTool;
}

class GarageMcpServer extends MCPServer {
  constructor(tools: ToolsInput) {
    super({
      id: 'garage',
      name: 'Garage MCP',
      version: '0.1.0',
      tools,
    });
    const rejectMutation = async (): Promise<void> => {
      throw new Error('Garage MCP tool registry is fixed.');
    };
    this.toolActions.add = rejectMutation;
    this.toolActions.remove = rejectMutation;
  }

  override convertTools(
    ...args: Parameters<MCPServer['convertTools']>
  ): ReturnType<MCPServer['convertTools']> {
    const [tools] = args;
    const converted = super.convertTools(...args);

    return Object.fromEntries(Object.entries(converted).map(([key, convertedTool]) => {
      const original = tools[key];
      return [key, original instanceof Tool
        ? preserveAgentContext(original, convertedTool)
        : convertedTool];
    }));
  }
}

export function createGarageMcpServer(
  root: ObjectStorage = createLazyGarageObjectStorage(),
): MCPServer {
  return new GarageMcpServer({
    create_text_object: createCreateTextObjectTool(root),
    get_text_object: createGetTextObjectTool(root),
    list_text_objects: createListTextObjectsTool(root),
    replace_text_object: createReplaceTextObjectTool(root),
    delete_object: createDeleteObjectTool(root),
  });
}

export const garageMcpServer = createGarageMcpServer();
