import type { ObjectStorage } from '@chekku/storage';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MASTRA_TOOL_MARKER, Tool, createTool } from '@mastra/core/tools';
import { MastraEditor } from '@mastra/editor';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OpenAICompatibleGateway } from '../gateways/openai-compatible.js';
import { createCreateTextObjectTool } from '../tools/garage-object-tools.js';
import { createGarageMcpServer, garageMcpServer } from './garage-mcp-server.js';

const toolIds = [
  'create_text_object',
  'delete_object',
  'get_text_object',
  'list_text_objects',
  'replace_text_object',
];

function createMemoryStore(): { storage: ObjectStorage; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const storage: ObjectStorage = {
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
  return { storage, objects };
}

function toolCallingModel(toolName: string, input: Record<string, unknown>) {
  let calls = 0;
  return {
    specificationVersion: 'v2' as const,
    provider: 'test',
    modelId: `test-${toolName}`,
    supportedUrls: {},
    async doGenerate() {
      calls += 1;
      return {
        content: calls === 1
          ? [{ type: 'tool-call' as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }]
          : [{ type: 'text' as const, text: 'finished' }],
        finishReason: calls === 1 ? 'tool-calls' as const : 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('Streaming is not used by this test.');
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
    const { storage } = createMemoryStore();
    const server = createGarageMcpServer(storage);
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

  it('rejects dynamic tool mutation and retains the fixed generic registry', async () => {
    const { storage } = createMemoryStore();
    const server = createGarageMcpServer(storage);
    const extraTool = createTool({
      id: 'extra_tool',
      description: 'Must not be registered.',
      inputSchema: z.object({}).strict(),
      execute: async () => ({ ok: true }),
    });

    await expect(server.toolActions.add({ extra_tool: extraTool }))
      .rejects.toThrow('Garage MCP tool registry is fixed.');
    await expect(server.toolActions.remove(['create_text_object']))
      .rejects.toThrow('Garage MCP tool registry is fixed.');
    expect(Object.keys(server.tools()).sort()).toEqual(toolIds);
  });

  it('fails closed when invoked through the MCP protocol without agent context', async () => {
    const { storage, objects } = createMemoryStore();
    const server = createGarageMcpServer(storage);

    await expect(server.executeTool('create_text_object', {
      key: 'notes/a.txt',
      text: 'hello',
    })).rejects.toThrow('Agent identity is required.');
    expect(objects.size).toBe(0);
  });

  it('executes a hydrated tool with trusted agent context in its storage namespace', async () => {
    const { storage: objectStorage, objects } = createMemoryStore();
    const server = createGarageMcpServer(objectStorage);
    const editor = new MastraEditor({ source: 'db' });
    const runtime = new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: { garage: server },
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
    const tools = await hydrated!.listTools();
    const context = {
      agent: { agentId: 'garage-agent', toolCallId: 'call-1', messages: [], suspend: async () => undefined },
    } as never;

    expect(Object.keys(tools).sort()).toEqual(toolIds);
    await expect(tools.create_text_object?.execute?.(
      { key: 'notes/a.txt', text: 'hello' },
      context,
    )).resolves.toEqual({ key: 'notes/a.txt', sizeBytes: 5 });
    expect(objects).toEqual(new Map([
      [`agents/${Buffer.from('garage-agent').toString('base64url')}/notes/a.txt`, 'hello'],
    ]));
  });

  it('declines a hydrated replace approval without mutating storage', async () => {
    const { storage: objectStorage, objects } = createMemoryStore();
    const server = createGarageMcpServer(objectStorage);
    const editor = new MastraEditor({ source: 'db' });
    new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: { garage: server },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });
    await editor.agent.create({
      id: 'approval-agent',
      name: 'Approval Agent',
      instructions: 'Use Garage tools.',
      model: { provider: 'openai-compatible', name: 'gateway/test-model' },
      mcpClients: { garage: { tools: {} } },
    });
    const physicalKey = `agents/${Buffer.from('approval-agent').toString('base64url')}/notes/a.txt`;
    objects.set(physicalKey, 'before');
    const hydrated = await editor.agent.getById('approval-agent', { status: 'draft' });
    const model = toolCallingModel('replace_text_object', { key: 'notes/a.txt', text: 'after' });
    hydrated!.__updateModel({ model });

    const pending = await hydrated!.generate('Replace the note.');

    expect(pending.finishReason).toBe('suspended');
    expect(objects.get(physicalKey)).toBe('before');
    await hydrated!.declineToolCallGenerate({ runId: pending.runId! });
    expect(objects.get(physicalKey)).toBe('before');
  });

  it('executes a hydrated delete only after approval', async () => {
    const { storage: objectStorage, objects } = createMemoryStore();
    const server = createGarageMcpServer(objectStorage);
    const editor = new MastraEditor({ source: 'db' });
    new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: { garage: server },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });
    await editor.agent.create({
      id: 'delete-approval-agent',
      name: 'Delete Approval Agent',
      instructions: 'Use Garage tools.',
      model: { provider: 'openai-compatible', name: 'gateway/test-model' },
      mcpClients: { garage: { tools: {} } },
    });
    const physicalKey = `agents/${Buffer.from('delete-approval-agent').toString('base64url')}/notes/a.txt`;
    objects.set(physicalKey, 'before');
    const hydrated = await editor.agent.getById('delete-approval-agent', { status: 'draft' });
    const model = toolCallingModel('delete_object', { key: 'notes/a.txt' });
    hydrated!.__updateModel({ model });

    const pending = await hydrated!.generate('Delete the note.');

    expect(pending.finishReason).toBe('suspended');
    expect(objects.has(physicalKey)).toBe(true);
    await hydrated!.approveToolCallGenerate({ runId: pending.runId! });
    expect(objects.has(physicalKey)).toBe(false);
  });

  it('preserves context for marker-bearing tools from another core instance', async () => {
    const { storage: objectStorage, objects } = createMemoryStore();
    const localTool = createCreateTextObjectTool(objectStorage);
    const markerTool = {
      [MASTRA_TOOL_MARKER]: true,
      id: localTool.id,
      description: localTool.description,
      inputSchema: localTool.inputSchema,
      outputSchema: localTool.outputSchema,
      requireApproval: localTool.requireApproval,
      mcp: localTool.mcp,
      execute: localTool.execute,
    };
    expect(markerTool).not.toBeInstanceOf(Tool);

    const server = createGarageMcpServer(objectStorage);
    const editor = new MastraEditor({ source: 'db' });
    const runtime = new Mastra({
      storage: new InMemoryStore(),
      editor,
      mcpServers: { garage: server },
      gateways: { openAICompatible: new OpenAICompatibleGateway() },
    });
    void runtime;
    const converted = server.convertTools({ create_text_object: markerTool });
    server.convertedTools = {
      ...server.convertedTools,
      create_text_object: converted.create_text_object!,
    };

    await editor.agent.create({
      id: 'foreign-tool-agent',
      name: 'Foreign Tool Agent',
      instructions: 'Use generic Garage object tools.',
      model: { provider: 'openai-compatible', name: 'gateway/test-model' },
      mcpClients: { garage: { tools: {} } },
    });
    const hydrated = await editor.agent.getById('foreign-tool-agent', { status: 'draft' });
    const tool = (await hydrated!.listTools()).create_text_object;
    const context = {
      agent: { agentId: 'foreign-tool-agent', toolCallId: 'call-1', messages: [], suspend: async () => undefined },
    } as never;

    await expect(tool?.execute?.({ key: 'notes/a.txt', text: 'hello' }, context))
      .resolves.toEqual({ key: 'notes/a.txt', sizeBytes: 5 });
    expect(objects).toEqual(new Map([
      [`agents/${Buffer.from('foreign-tool-agent').toString('base64url')}/notes/a.txt`, 'hello'],
    ]));
  });
});
