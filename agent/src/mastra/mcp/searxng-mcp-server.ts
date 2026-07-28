import type { ToolsInput } from '@mastra/core/agent';
import { MCPServer } from '@mastra/mcp';

import { searchWebTool } from '../tools/searxng-search.js';

class SearxngMcpServer extends MCPServer {
  constructor(tools: ToolsInput) {
    super({ id: 'searxng', name: 'SearXNG MCP', version: '0.1.0', tools });
    const rejectMutation = async (): Promise<void> => {
      throw new Error('SearXNG MCP tool registry is fixed.');
    };
    this.toolActions.add = rejectMutation;
    this.toolActions.remove = rejectMutation;
  }
}

export function createSearxngMcpServer(tool = searchWebTool): MCPServer {
  return new SearxngMcpServer({ search_web: tool });
}

export const searxngMcpServer = createSearxngMcpServer();
