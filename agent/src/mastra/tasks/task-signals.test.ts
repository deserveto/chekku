import { describe, expect, it } from 'vitest';
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
