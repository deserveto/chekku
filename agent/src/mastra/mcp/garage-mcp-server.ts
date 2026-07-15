import { createLazyGarageObjectStorage, type ObjectStorage } from '@chekku/storage';
import type { ToolsInput } from '@mastra/core/agent';
import { MCPServer } from '@mastra/mcp';

import {
  createCreateTextObjectTool,
  createDeleteObjectTool,
  createGetTextObjectTool,
  createListTextObjectsTool,
  createReplaceTextObjectTool,
} from '../tools/garage-object-tools.js';

class GarageMcpServer extends MCPServer {
  readonly #agentTools: ToolsInput;

  constructor(tools: ToolsInput) {
    super({
      id: 'garage',
      name: 'Garage MCP',
      version: '0.1.0',
      tools,
    });
    this.#agentTools = tools;
  }

  override tools(): ReturnType<MCPServer['tools']> {
    // Editor must hydrate original tools so agent execution can supply trusted agent context.
    return this.#agentTools as ReturnType<MCPServer['tools']>;
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
