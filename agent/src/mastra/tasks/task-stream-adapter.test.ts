import { describe, expect, it } from 'vitest';
import { extractTaskSnapshot } from './task-stream-adapter.js';

function taskResultChunk(toolName: string, result: unknown, extra = {}) {
  return {
    type: 'tool-result',
    payload: { toolCallId: 'tc-1', toolName, result, ...extra },
  };
}

const SNAPSHOT = [
  {
    id: 'task_identify',
    content: 'Identify authentication flows',
    activeForm: 'Identifying authentication flows',
    status: 'completed',
  },
  {
    id: 'task_login',
    content: 'Test login',
    activeForm: 'Testing login flow',
    status: 'in_progress',
  },
  { id: 'task_reset', content: 'Test password reset', status: 'pending' },
];

describe('extractTaskSnapshot', () => {
  it('normalizes a successful task tool result into a task list', () => {
    const tasks = extractTaskSnapshot(
      taskResultChunk('task_write', {
        content: 'Tasks updated',
        tasks: SNAPSHOT,
        isError: false,
      }),
    );

    expect(tasks).toEqual([
      {
        id: 'task_identify',
        content: 'Identify authentication flows',
        activeForm: 'Identifying authentication flows',
        status: 'completed',
      },
      {
        id: 'task_login',
        content: 'Test login',
        activeForm: 'Testing login flow',
        status: 'in_progress',
      },
      {
        id: 'task_reset',
        content: 'Test password reset',
        activeForm: 'Test password reset',
        status: 'pending',
      },
    ]);
  });

  it('accepts snapshots from every task tool', () => {
    for (const tool of [
      'task_write',
      'task_update',
      'task_complete',
      'task_check',
    ]) {
      expect(
        extractTaskSnapshot(
          taskResultChunk(tool, { content: 'ok', tasks: SNAPSHOT, isError: false }),
        ),
      ).not.toBeNull();
    }
  });

  it('ignores non-task tools', () => {
    expect(
      extractTaskSnapshot(
        taskResultChunk('search_web', { content: 'ok', tasks: SNAPSHOT }),
      ),
    ).toBeNull();
  });

  it('ignores error results', () => {
    expect(
      extractTaskSnapshot(
        taskResultChunk('task_write', {
          content: 'failed',
          tasks: SNAPSHOT,
          isError: true,
        }),
      ),
    ).toBeNull();
  });

  it('ignores other chunk types', () => {
    expect(extractTaskSnapshot({ type: 'text-delta', payload: { text: 'hi' } })).toBeNull();
    expect(
      extractTaskSnapshot({
        type: 'tool-error',
        payload: { toolCallId: 'tc-1', toolName: 'task_write', error: 'x' },
      }),
    ).toBeNull();
    expect(extractTaskSnapshot({ type: 'tool-call', payload: {} })).toBeNull();
  });

  it('ignores malformed payloads instead of throwing', () => {
    expect(extractTaskSnapshot(taskResultChunk('task_write', undefined))).toBeNull();
    expect(extractTaskSnapshot(taskResultChunk('task_write', 'text'))).toBeNull();
    expect(extractTaskSnapshot(taskResultChunk('task_write', null))).toBeNull();
    expect(
      extractTaskSnapshot(taskResultChunk('task_write', { tasks: 'nope' })),
    ).toBeNull();
    expect(
      extractTaskSnapshot(
        taskResultChunk('task_write', { tasks: [{ id: 'x' }] }),
      ),
    ).toBeNull();
  });

  it('emits an empty snapshot when the model clears the list', () => {
    // `task_write({ tasks: [] })` is valid input; dropping it kept the
    // pre-clearing snapshot on the dock and resurrected the deleted list
    // after reload. An empty snapshot is a first-class "cleared" state.
    expect(
      extractTaskSnapshot(
        taskResultChunk('task_write', { content: 'ok', tasks: [], isError: false }),
      ),
    ).toEqual([]);
  });

  it('skips entries whose id exceeds the id cap', () => {
    // A runaway id would otherwise flow into the run event payload (one
    // event can evict much of the 4 MiB run buffer) and into React keys.
    const tasks = extractTaskSnapshot(
      taskResultChunk('task_write', {
        content: 'ok',
        tasks: [
          { id: 'x'.repeat(129), content: 'huge id', status: 'pending' },
          { id: 'ok-id', content: 'Fine task', status: 'pending' },
        ],
        isError: false,
      }),
    );
    expect(tasks).toEqual([
      {
        id: 'ok-id',
        content: 'Fine task',
        activeForm: 'Fine task',
        status: 'pending',
      },
    ]);
  });

  it('skips invalid entries but keeps valid siblings', () => {
    const tasks = extractTaskSnapshot(
      taskResultChunk('task_update', {
        content: 'ok',
        tasks: [
          { id: 'good', content: 'Valid task', status: 'pending' },
          { id: '', content: 'missing id', status: 'pending' },
          { content: 'no id', status: 'pending' },
          { id: 'bad-status', content: 'invalid status', status: 'done' },
          'not-an-object',
          null,
        ],
        isError: false,
      }),
    );

    expect(tasks).toEqual([
      {
        id: 'good',
        content: 'Valid task',
        activeForm: 'Valid task',
        status: 'pending',
      },
    ]);
  });

  it('bounds task text length and count', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      id: `t-${index}`,
      content: 'Task',
      status: 'pending',
    }));
    const tasks = extractTaskSnapshot(
      taskResultChunk('task_write', { content: 'ok', tasks: many, isError: false }),
    );
    expect(tasks).toHaveLength(100);

    const long = extractTaskSnapshot(
      taskResultChunk('task_write', {
        content: 'ok',
        tasks: [
          {
            id: 't-1',
            content: 'x'.repeat(2_000),
            activeForm: 'y'.repeat(2_000),
            status: 'in_progress',
          },
        ],
        isError: false,
      }),
    );
    expect(long![0]!.content.length).toBeLessThanOrEqual(500);
    expect(long![0]!.activeForm.length).toBeLessThanOrEqual(500);
  });

  it('falls back activeForm to content when missing or blank', () => {
    const tasks = extractTaskSnapshot(
      taskResultChunk('task_write', {
        content: 'ok',
        tasks: [
          { id: 'a', content: 'Do A', status: 'pending' },
          { id: 'b', content: 'Do B', activeForm: '   ', status: 'pending' },
        ],
        isError: false,
      }),
    );
    expect(tasks!.map((task) => task.activeForm)).toEqual(['Do A', 'Do B']);
  });
});
