import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createSearxngMcpServer,
  searxngMcpServer,
} from './searxng-mcp-server.js';

describe('SearXNG MCP server', () => {
  it('registers exactly search_web', () => {
    expect(searxngMcpServer.id).toBe('searxng');
    expect(Object.keys(searxngMcpServer.tools())).toEqual(['search_web']);
  });

  it('rejects dynamic registry mutation', async () => {
    const server = createSearxngMcpServer();
    const extra = createTool({
      id: 'extra', description: 'not allowed', inputSchema: z.object({}),
      execute: async () => ({}),
    });
    await expect(server.toolActions.add({ extra }))
      .rejects.toThrow('SearXNG MCP tool registry is fixed.');
    await expect(server.toolActions.remove(['search_web']))
      .rejects.toThrow('SearXNG MCP tool registry is fixed.');
    expect(Object.keys(server.tools())).toEqual(['search_web']);
  });
});
