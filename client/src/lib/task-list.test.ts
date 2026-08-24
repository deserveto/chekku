import { describe, expect, it } from 'vitest';
import {
  applyTaskSnapshot,
  isTaskToolName,
  parseTaskListPayload,
  taskProgress,
  tasksFromRestoredParts,
  withoutTaskToolParts,
  type TaskItem,
} from './task-list';
import type { AssistantPart } from './types';

const SNAPSHOT: TaskItem[] = [
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

describe('parseTaskListPayload', () => {
  it('parses a valid task-list payload', () => {
    expect(
      parseTaskListPayload({
        tasks: [
          ...SNAPSHOT,
          { id: 'x', content: '  Trim me  ', status: 'pending' },
        ],
      }),
    ).toEqual([
      SNAPSHOT[0]!,
      SNAPSHOT[1]!,
      { ...SNAPSHOT[2]!, activeForm: 'Test password reset' },
      { id: 'x', content: 'Trim me', activeForm: 'Trim me', status: 'pending' },
    ]);
  });

  it('rejects malformed payloads', () => {
    expect(parseTaskListPayload(null)).toBeNull();
    expect(parseTaskListPayload('tasks')).toBeNull();
    expect(parseTaskListPayload({})).toBeNull();
    expect(parseTaskListPayload({ tasks: 'no' })).toBeNull();
    expect(parseTaskListPayload({ tasks: [{ id: 'x' }] })).toBeNull();
    expect(
      parseTaskListPayload({
        tasks: [{ id: 'x', content: 'do', status: 'done' }],
      }),
    ).toBeNull();
  });

  it('accepts an empty array as a cleared list', () => {
    // task_write({ tasks: [] }) clears the list; the empty snapshot must
    // reach the dock instead of being dropped (which resurrected the
    // deleted list after reload).
    expect(parseTaskListPayload({ tasks: [] })).toEqual([]);
  });

  it('skips entries whose id exceeds the id cap', () => {
    expect(
      parseTaskListPayload({
        tasks: [
          { id: 'x'.repeat(129), content: 'huge id', status: 'pending' },
          { id: 'ok', content: 'fine', status: 'pending' },
        ],
      }),
    ).toEqual([
      { id: 'ok', content: 'fine', activeForm: 'fine', status: 'pending' },
    ]);
  });
});

describe('applyTaskSnapshot', () => {
  it('replaces the previous snapshot instead of merging', () => {
    const first = applyTaskSnapshot(null, SNAPSHOT);
    const second = applyTaskSnapshot(first, [
      { ...SNAPSHOT[0]!, status: 'completed' },
      { ...SNAPSHOT[1]!, status: 'in_progress' },
      SNAPSHOT[2]!,
    ]);

    expect(second.tasks).toHaveLength(3);
    expect(second.tasks[0]!.status).toBe('completed');
  });

  it('records the update timestamp when provided', () => {
    const state = applyTaskSnapshot(null, SNAPSHOT, '2026-01-01T00:00:00Z');
    expect(state.updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(applyTaskSnapshot(null, SNAPSHOT).updatedAt).toBeUndefined();
  });
});

describe('taskProgress', () => {
  it('counts completed tasks', () => {
    expect(taskProgress(SNAPSHOT)).toEqual({ completed: 1, total: 3 });
    expect(taskProgress([])).toEqual({ completed: 0, total: 0 });
  });
});

describe('isTaskToolName', () => {
  it('matches exactly the four task tools', () => {
    for (const name of [
      'task_write',
      'task_update',
      'task_complete',
      'task_check',
    ]) {
      expect(isTaskToolName(name)).toBe(true);
    }
    expect(isTaskToolName('search_web')).toBe(false);
    expect(isTaskToolName(undefined)).toBe(false);
    expect(isTaskToolName('')).toBe(false);
  });
});

describe('withoutTaskToolParts', () => {
  it('drops task tool parts and keeps everything else in order', () => {
    const parts: AssistantPart[] = [
      { type: 'text', id: 't1', content: 'starting' },
      {
        type: 'tool',
        id: 't2',
        toolCallId: 'tc-1',
        toolName: 'task_write',
        status: 'complete',
        result: { tasks: SNAPSHOT },
      },
      {
        type: 'tool',
        id: 't3',
        toolCallId: 'tc-2',
        toolName: 'browser_navigate',
        status: 'complete',
      },
      { type: 'text', id: 't4', content: 'done' },
    ];

    expect(withoutTaskToolParts(parts).map((part) => part.id)).toEqual([
      't1',
      't3',
      't4',
    ]);
  });
});

describe('tasksFromRestoredParts', () => {
  it('recovers the latest valid snapshot from restored parts', () => {
    const parts: AssistantPart[] = [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 'tc-1',
        toolName: 'task_write',
        status: 'complete',
        result: { content: 'ok', tasks: SNAPSHOT, isError: false },
      },
      {
        type: 'tool',
        id: 't2',
        toolCallId: 'tc-2',
        toolName: 'task_update',
        status: 'complete',
        result: {
          content: 'ok',
          tasks: SNAPSHOT.map((task, index) =>
            index < 2 ? { ...task, status: 'completed' as const } : task,
          ),
          isError: false,
        },
      },
    ];

    const tasks = tasksFromRestoredParts(parts);
    expect(tasks).not.toBeNull();
    expect(taskProgress(tasks!)).toEqual({ completed: 2, total: 3 });
  });

  it('ignores errored task parts and malformed results', () => {
    const parts: AssistantPart[] = [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 'tc-1',
        toolName: 'task_write',
        status: 'error',
        result: { tasks: SNAPSHOT },
      },
      {
        type: 'tool',
        id: 't2',
        toolCallId: 'tc-2',
        toolName: 'task_check',
        status: 'complete',
        result: 'garbage',
      },
    ];
    expect(tasksFromRestoredParts(parts)).toBeNull();
    expect(tasksFromRestoredParts(undefined)).toBeNull();
  });

  it('skips non-task tools entirely', () => {
    const parts: AssistantPart[] = [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 'tc-1',
        toolName: 'search_web',
        status: 'complete',
        result: { tasks: SNAPSHOT },
      },
    ];
    expect(tasksFromRestoredParts(parts)).toBeNull();
  });

  it('restores a cleared list instead of the last non-empty snapshot', () => {
    const parts: AssistantPart[] = [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 'tc-1',
        toolName: 'task_write',
        status: 'complete',
        result: { content: 'ok', tasks: SNAPSHOT, isError: false },
      },
      {
        type: 'tool',
        id: 't2',
        toolCallId: 'tc-2',
        toolName: 'task_write',
        status: 'complete',
        result: { content: 'cleared', tasks: [], isError: false },
      },
    ];
    expect(tasksFromRestoredParts(parts)).toEqual([]);
  });
});
