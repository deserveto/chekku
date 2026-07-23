import type { ToolsInput } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
import { MCPServer } from '@mastra/mcp';

import { readWebPageTool } from '../tools/web-reader.js';

class WebReaderMcpServer extends MCPServer {
  constructor(tools: ToolsInput) {
    super({ id: 'web-reader', name: 'Web Reader MCP', version: '0.1.0', tools });
    Object.freeze(this.convertedTools);
    const rejectMutation = async (): Promise<void> => {
      throw new Error('Web Reader MCP tool registry is fixed.');
    };
    this.toolActions.add = rejectMutation;
    this.toolActions.remove = rejectMutation;
  }

  override __registerMastra(mastra: Mastra): void {
    super.__registerMastra(mastra);
    Object.freeze(this.convertedTools);
  }
}

export function createWebReaderMcpServer(tool = readWebPageTool): MCPServer {
  return new WebReaderMcpServer({ read_web_page: tool });
}

export const webReaderMcpServer = createWebReaderMcpServer();
