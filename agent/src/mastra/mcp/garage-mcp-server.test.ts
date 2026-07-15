import type { ObjectStorage } from '@chekku/storage';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraEditor } from '@mastra/editor';
import { describe, expect, it } from 'vitest';

import { OpenAICompatibleGateway } from '../gateways/openai-compatible.js';
import { createGarageMcpServer, garageMcpServer } from './garage-mcp-server.js';

const toolIds = [
  'create_text_object',
  'delete_object',
  'get_text_object',
  'list_text_objects',
  'replace_text_object',
];

function createMemoryStore(): ObjectStorage {
  const objects = new Map<string, string>();
  return {
    async createText(key, value) {
      if (objects.has(key)) throw new Error('already exists');
      objects.set(key, value);
    },
    async replaceText(key, value) {
      if (!objects.has(key)) throw new Error('not found');
      objects.set(key, value);
    },
    async getText(key) {
      const value = objects.get(key);
      if (value === undefined) throw new Error('not found');
      return value;
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      if (!objects.delete(key)) throw new Error('not found');
    },
    async listKeys(prefix, options) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const limit = options?.limit ?? keys.length;
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
}

describe('Garage MCP server', () => {
  it('registers exactly five generic tools and no PM behavior', () => {
    expect(garageMcpServer.id).toBe('garage');
    expect(Object.keys(garageMcpServer.tools()).sort()).toEqual(toolIds);
    expect(Object.keys(garageMcpServer.tools()).join(' ')).not.toMatch(/pm|report/i);
  });

  it('exposes accurate annotations through server.tools()', () => {
    const tools = garageMcpServer.tools();

    expect(tools.create_text_object?.mcp?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.get_text_object?.mcp?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.list_text_objects?.mcp?.annotations).toEqual(
      tools.get_text_object?.mcp?.annotations,
    );
    expect(tools.replace_text_object?.mcp?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.delete_object?.mcp?.annotations).toEqual(
      tools.replace_text_object?.mcp?.annotations,
    );
  });

  it('executes registered tools with trusted agent context', async () => {
    const server = createGarageMcpServer(createMemoryStore());
    const tools = server.tools();
    const context = {
      agent: { agentId: 'stored-agent', toolCallId: 'call-1', messages: [], suspend: async () => undefined },
    } as never;

    await expect(tools.create_text_object?.execute?.(
      { key: 'notes/a.txt', text: 'hello' },
      context,
    )).resolves.toEqual({ key: 'notes/a.txt', sizeBytes: 5 });
    await expect(tools.get_text_object?.execute?.({ key: 'notes/a.txt' }, context)).resolves.toEqual({
      key: 'notes/a.txt',
      text: 'hello',
      sizeBytes: 5,
    });
  });

  it('hydrates all five tools into an actual stored agent through MastraEditor', async () => {
    const editor = new MastraEditor({ source: 'db' });
    const runtime = new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: { garage: garageMcpServer },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });
    void runtime;

    await editor.agent.create({
      id: 'garage-agent',
      name: 'Garage Agent',
      instructions: 'Use generic Garage object tools.',
      model: { provider: 'openai-compatible', name: 'gateway/test-model' },
      mcpClients: { garage: { tools: {} } },
    });
    editor.agent.clearCache('garage-agent');
    const hydrated = await editor.agent.getById('garage-agent', { status: 'draft' });

    expect(Object.keys(await hydrated!.listTools()).sort()).toEqual(toolIds);
  });
});
