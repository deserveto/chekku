import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundTaskTools } from './bounded-task-tools.js';
import { createTaskSignals, TASK_TOOL_NAMES } from './task-signals.js';

describe('createTaskSignals', () => {
  it('returns a task signal provider list', () => {
    const signals = createTaskSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.id).toBe('task-signals');
  });

  it('returns fresh provider instances per call so agents stay isolated', () => {
    // SignalProvider.connect() binds a provider to ONE agent; sharing an
    // instance across agents would cross-wire their links.
    const a = createTaskSignals();
    const b = createTaskSignals();
    expect(a[0]).not.toBe(b[0]);
  });

  it('covers exactly the four Mastra task tools', () => {
    expect([...TASK_TOOL_NAMES].sort()).toEqual([
      'task_check',
      'task_complete',
      'task_update',
      'task_write',
    ]);
  });
});

describe('boundTaskTools', () => {
  it('carries the base tool outputSchema forward', () => {
    // The wrapper narrows input only; dropping the base output contract
    // would silently relax validation core still applies.
    const outputSchema = z.object({ ok: z.boolean() });
    const base = createTool({
      id: 'task_write',
      description: 'write tasks',
      inputSchema: z.object({}),
      outputSchema,
      execute: async () => ({ ok: true }),
    });
    const wrapped = boundTaskTools({
      task_write: base as Parameters<typeof boundTaskTools>[0]['task_write'],
    });
    // createTool may normalize the schema shape; the wrapper must carry
    // the base tool's processed output contract unchanged.
    expect(wrapped.task_write?.outputSchema).toBe(base.outputSchema);
  });
});
