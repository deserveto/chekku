import type { ObjectStorage } from '@chekku/storage';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createCreateTextObjectTool,
  createDeleteObjectTool,
  createGetTextObjectTool,
  createListTextObjectsTool,
  createReplaceTextObjectTool,
} from './garage-object-tools.js';

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, string>();
  readonly calls: string[] = [];
  readonly listLimits: Array<number | undefined> = [];

  async createText(key: string, value: string): Promise<void> {
    this.calls.push(`create:${key}`);
    if (this.objects.has(key)) throw new Error('already exists');
    this.objects.set(key, value);
  }

  async replaceText(key: string, value: string): Promise<void> {
    this.calls.push(`replace:${key}`);
    if (!this.objects.has(key)) throw new Error('not found');
    this.objects.set(key, value);
  }

  async getText(key: string): Promise<string> {
    this.calls.push(`get:${key}`);
    const value = this.objects.get(key);
    if (value === undefined) throw new Error('not found');
    return value;
  }

  async exists(key: string): Promise<boolean> {
    this.calls.push(`exists:${key}`);
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    if (!this.objects.delete(key)) throw new Error('not found');
  }

  async listKeys(prefix: string, options?: { limit?: number }) {
    this.calls.push(`list:${prefix}`);
    this.listLimits.push(options?.limit);
    const matches = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const limit = options?.limit ?? matches.length;
    return { keys: matches.slice(0, limit), truncated: matches.length > limit };
  }
}

const agentContext = (agentId: string) => ({
  agent: { agentId, toolCallId: 'call-1', messages: [], suspend: async () => undefined },
}) as never;

const annotations = {
  create: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  destructive: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

describe('Garage object tools', () => {
  it('creates, gets, replaces, lists, and deletes text objects with exact results', async () => {
    const root = new MemoryObjectStorage();
    const context = agentContext('agent-alpha');
    const create = createCreateTextObjectTool(root);
    const get = createGetTextObjectTool(root);
    const replace = createReplaceTextObjectTool(root);
    const list = createListTextObjectsTool(root);
    const remove = createDeleteObjectTool(root);

    await expect(create.execute!({ key: 'notes/a.txt', text: 'hello' }, context)).resolves.toEqual({
      key: 'notes/a.txt',
      sizeBytes: 5,
    });
    await expect(get.execute!({ key: 'notes/a.txt' }, context)).resolves.toEqual({
      key: 'notes/a.txt',
      text: 'hello',
      sizeBytes: 5,
    });
    await expect(replace.execute!({ key: 'notes/a.txt', text: 'world' }, context)).resolves.toEqual({
      key: 'notes/a.txt',
      sizeBytes: 5,
    });
    await expect(list.execute!({ prefix: 'notes/' }, context)).resolves.toEqual({
      keys: ['notes/a.txt'],
      truncated: false,
    });
    await expect(remove.execute!({ key: 'notes/a.txt' }, context)).resolves.toEqual({
      key: 'notes/a.txt',
      deleted: true,
    });
  });

  it('uses only trusted agent context and performs no storage calls without it', async () => {
    const root = new MemoryObjectStorage();
    const tool = createCreateTextObjectTool(root);

    await expect(tool.execute!({ key: 'notes/a.txt', text: 'hello' }, {} as never))
      .rejects.toThrow('Agent identity is required.');
    expect(root.calls).toEqual([]);
  });

  it('isolates equal relative keys by agent ID', async () => {
    const root = new MemoryObjectStorage();
    const create = createCreateTextObjectTool(root);
    const get = createGetTextObjectTool(root);

    await create.execute!({ key: 'notes/a.txt', text: 'alpha' }, agentContext('agent/alpha'));
    await create.execute!({ key: 'notes/a.txt', text: 'beta' }, agentContext('agent/alpha-2'));

    await expect(get.execute!({ key: 'notes/a.txt' }, agentContext('agent/alpha')))
      .resolves.toMatchObject({ text: 'alpha' });
    await expect(get.execute!({ key: 'notes/a.txt' }, agentContext('agent/alpha-2')))
      .resolves.toMatchObject({ text: 'beta' });
    expect(root.objects.size).toBe(2);
  });

  it('uses strict schemas and rejects text over 256 KiB by UTF-8 byte length', () => {
    const root = new MemoryObjectStorage();
    const create = createCreateTextObjectTool(root);
    const schema = create.inputSchema as unknown as z.ZodType;

    expect(schema.safeParse({ key: 'a.txt', text: 'x'.repeat(262_145) }).success).toBe(false);
    expect(schema.safeParse({ key: 'a.txt', text: 'ok', agentId: 'forged' }).success).toBe(false);
    expect(root.calls).toEqual([]);
  });

  it('requests 101 keys, returns at most 100, and reports truncation', async () => {
    const root = new MemoryObjectStorage();
    const namespace = Buffer.from('agent-alpha').toString('base64url');
    for (let index = 0; index < 101; index += 1) {
      root.objects.set(`agents/${namespace}/notes/${String(index).padStart(3, '0')}.txt`, 'x');
    }

    const result = await createListTextObjectsTool(root).execute!({}, agentContext('agent-alpha'));

    expect(result).toMatchObject({ truncated: true });
    expect((result as { keys: string[] }).keys).toHaveLength(100);
    expect(root.listLimits).toEqual([101]);
  });

  it('declares accurate MCP annotations and approval requirements', () => {
    const root = new MemoryObjectStorage();
    const create = createCreateTextObjectTool(root);
    const get = createGetTextObjectTool(root);
    const list = createListTextObjectsTool(root);
    const replace = createReplaceTextObjectTool(root);
    const remove = createDeleteObjectTool(root);

    expect(create.mcp?.annotations).toEqual(annotations.create);
    expect(get.mcp?.annotations).toEqual(annotations.read);
    expect(list.mcp?.annotations).toEqual(annotations.read);
    expect(replace.mcp?.annotations).toEqual(annotations.destructive);
    expect(remove.mcp?.annotations).toEqual(annotations.destructive);
    expect(replace.requireApproval).not.toBe(true);
    expect(remove.requireApproval).not.toBe(true);
    expect(create.requireApproval).not.toBe(true);
    expect(get.requireApproval).not.toBe(true);
    expect(list.requireApproval).not.toBe(true);
  });
});
