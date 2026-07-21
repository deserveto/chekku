import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { MastraEditor } from '@mastra/editor';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OpenAICompatibleGateway } from '../gateways/openai-compatible.js';
import { createReadWebPageTool } from '../tools/web-reader.js';
import { garageMcpServer } from './garage-mcp-server.js';
import { searxngMcpServer } from './searxng-mcp-server.js';
import {
  createWebReaderMcpServer,
  webReaderMcpServer,
} from './web-reader-mcp-server.js';

describe('Web Reader MCP server', () => {
  it('registers exactly read_web_page', () => {
    expect(webReaderMcpServer.id).toBe('web-reader');
    expect(Object.keys(webReaderMcpServer.tools())).toEqual(['read_web_page']);
  });

  it('rejects dynamic registry mutation', async () => {
    const server = createWebReaderMcpServer();
    const extra = createTool({
      id: 'extra', description: 'not allowed', inputSchema: z.object({}),
      execute: async () => ({}),
    });
    await expect(server.toolActions.add({ extra }))
      .rejects.toThrow('Web Reader MCP tool registry is fixed.');
    await expect(server.toolActions.remove(['read_web_page']))
      .rejects.toThrow('Web Reader MCP tool registry is fixed.');
    expect(Object.keys(server.tools())).toEqual(['read_web_page']);
  });

  it('hydrates every fixed MCP selection without a provider request', async () => {
    const normalizedOutput = {
      requestedUrl: 'https://example.com/',
      sourceUrl: 'https://example.com/',
      title: 'Example',
      markdown: 'content',
      contentIsUntrusted: true as const,
      truncated: false,
    };
    const fakeReadWebPageTool = createReadWebPageTool({
      read: async () => normalizedOutput,
    });
    const editor = new MastraEditor({ source: 'db' });
    new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: {
        garage: garageMcpServer,
        searxng: searxngMcpServer,
        'web-reader': createWebReaderMcpServer(fakeReadWebPageTool),
      },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });
    const cases = [
      [{ 'web-reader': { tools: {} } }, ['read_web_page']],
      [{ garage: { tools: {} }, 'web-reader': { tools: {} } }, [
        'create_text_object', 'delete_object', 'get_text_object',
        'list_text_objects', 'read_web_page', 'replace_text_object',
      ]],
      [{ searxng: { tools: {} }, 'web-reader': { tools: {} } }, [
        'read_web_page', 'search_web',
      ]],
      [{ garage: { tools: {} }, searxng: { tools: {} }, 'web-reader': { tools: {} } }, [
        'create_text_object', 'delete_object', 'get_text_object',
        'list_text_objects', 'read_web_page', 'replace_text_object', 'search_web',
      ]],
    ] as const;

    for (const [index, [mcpClients, expectedToolIds]] of cases.entries()) {
      const id = `web-reader-hydration-agent-${index}`;
      await editor.agent.create({
        id,
        name: `Web Reader Hydration Agent ${index}`,
        instructions: 'Use selected fixed MCP tools.',
        model: { provider: 'openai-compatible', name: 'gateway/test-model' },
        mcpClients,
      });
      const hydrated = await editor.agent.getById(id, { status: 'draft' });
      const tools = await hydrated!.listTools();

      expect(Object.keys(tools).sort()).toEqual(expectedToolIds);
      if (index === 0) {
        await expect(tools.read_web_page?.execute?.(
          { url: 'https://example.com/' },
          {} as never,
        )).resolves.toEqual(normalizedOutput);
      }
    }
  });
});
