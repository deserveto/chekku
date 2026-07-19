import { createTool } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraEditor } from '@mastra/editor';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OpenAICompatibleGateway } from '../gateways/openai-compatible.js';
import type { SearxngSearchClient } from '../searxng/client.js';
import { createSearchWebTool } from '../tools/searxng-search.js';
import { garageMcpServer } from './garage-mcp-server.js';
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

  it('hydrates Garage and SearXNG tools without a network request', async () => {
    const normalizedResult = {
      query: 'release risks',
      page: 1,
      results: [{
        url: 'https://example.com/release-risks',
        title: 'Release risks',
        snippet: 'Normalized search result.',
        engines: ['fake'],
      }],
      answers: [],
      corrections: [],
      suggestions: [],
      truncated: false,
    };
    const client: SearxngSearchClient = {
      search: async () => normalizedResult,
    };
    const editor = new MastraEditor({ source: 'db' });
    new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: {
        garage: garageMcpServer,
        searxng: createSearxngMcpServer(createSearchWebTool(client)),
      },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });

    await editor.agent.create({
      id: 'search-and-storage-agent',
      name: 'Search And Storage Agent',
      instructions: 'Use Garage and SearXNG tools.',
      model: { provider: 'openai-compatible', name: 'gateway/test-model' },
      mcpClients: {
        garage: { tools: {} },
        searxng: { tools: {} },
      },
    });
    const hydrated = await editor.agent.getById('search-and-storage-agent', { status: 'draft' });
    const tools = await hydrated!.listTools();

    expect(Object.keys(tools).sort()).toEqual([
      'create_text_object',
      'delete_object',
      'get_text_object',
      'list_text_objects',
      'replace_text_object',
      'search_web',
    ]);
    await expect(tools.search_web?.execute?.(
      { query: ' release risks ' },
      {} as never,
    )).resolves.toEqual(normalizedResult);
  });
});
