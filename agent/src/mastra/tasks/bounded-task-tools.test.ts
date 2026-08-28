import { describe, expect, it, vi } from 'vitest';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { boundTaskTools } from './bounded-task-tools.js';

/** Tool.inputSchema is typed as StandardSchema; the wrapped value is the
 *  zod object we passed, so cast for safeParse assertions. */
function schema(tool: unknown): z.ZodTypeAny {
  return (tool as { inputSchema: z.ZodTypeAny }).inputSchema;
}

/**
 * The four Mastra task tools accept unbounded input (`z.string().min(1)`
 * fields, no array cap), and task content is model-authored — an
 * externally-influenced growth path in the long-lived agent server. The
 * Chekku boundary must narrow the schemas before the model's arguments
 * ever reach storage.
 */
describe('boundTaskTools', () => {
  const baseTools = {
    task_write: createTool({
      id: 'task_write',
      description: 'base',
      inputSchema: z.object({ tasks: z.array(z.any()) }),
      execute: vi.fn(async () => ({ content: 'ok', tasks: [], isError: false })),
    }),
    task_update: createTool({
      id: 'task_update',
      description: 'base',
      inputSchema: z.object({ id: z.string() }),
      execute: vi.fn(async () => ({ content: 'ok', tasks: [], isError: false })),
    }),
  };

  it('rejects task lists above the max task count', () => {
    const tools = boundTaskTools(baseTools);
    const tasks = Array.from({ length: 101 }, (_, i) => ({
      content: `Task ${i}`,
      status: 'pending',
      activeForm: `Working on task ${i}`,
    }));
    const parsed = schema(tools.task_write).safeParse({ tasks });
    expect(parsed.success).toBe(false);
  });

  it('rejects task field text above the max length', () => {
    const tools = boundTaskTools(baseTools);
    const long = 'x'.repeat(501);
    expect(
      schema(tools.task_write).safeParse({
        tasks: [{ content: long, status: 'pending', activeForm: 'ok' }],
      }).success,
    ).toBe(false);
    expect(
      schema(tools.task_write).safeParse({
        tasks: [{ content: 'ok', status: 'pending', activeForm: long }],
      }).success,
    ).toBe(false);
    expect(
      schema(tools.task_update).safeParse({ content: long }).success,
    ).toBe(false);
    expect(
      schema(tools.task_update).safeParse({ activeForm: long }).success,
    ).toBe(false);
  });

  it('rejects task ids above the max length', () => {
    const tools = boundTaskTools(baseTools);
    expect(
      schema(tools.task_write).safeParse({
        tasks: [
          {
            id: 'x'.repeat(129),
            content: 'ok',
            status: 'pending',
            activeForm: 'ok',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      schema(tools.task_update).safeParse({ id: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('accepts valid input and delegates execution to the base tool', async () => {
    const executeSpy = vi.fn(
      async (_input: unknown, _context: unknown) => ({
        content: 'ok',
        tasks: [],
        isError: false,
      }),
    );
    const base = {
      task_write: createTool({
        id: 'task_write',
        description: 'base',
        inputSchema: z.object({ tasks: z.array(z.any()) }),
        execute: executeSpy,
      }),
    };
    const tools = boundTaskTools(base);
    const input = {
      tasks: [{ content: 'Valid task', status: 'pending', activeForm: 'Working' }],
    };
    expect(schema(tools.task_write).safeParse(input).success).toBe(true);

    const context = { agent: { id: 'test-agent' } } as never;
    await tools.task_write?.execute?.(input as never, context);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]![0]).toEqual(input);
  });
});
