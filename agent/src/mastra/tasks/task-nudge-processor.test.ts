import { describe, expect, it } from 'vitest';
import {
  TASK_NUDGE_MARKER,
  TASK_NUDGE_MESSAGE,
  TASK_NUDGE_TOOL_THRESHOLD,
  createTaskNudgeProcessor,
  getTaskNudgeDecision,
} from './task-nudge-processor.js';
import { TASK_TOOL_NAMES } from './task-signals.js';

type Part = {
  type: string;
  toolInvocation: { toolCallId: string; toolName: string };
};

function assistantToolCall(toolCallId: string, toolName: string): Part {
  return { type: 'tool-invocation', toolInvocation: { toolCallId, toolName } };
}

function msg(role: string, parts: Part[]) {
  return { role, content: { format: 2, parts } };
}

function stepArgs(messages: unknown[], systemMessages: unknown[] = []) {
  return { messages, systemMessages };
}

describe('getTaskNudgeDecision', () => {
  it('does not nudge before the distinct-tool threshold in the current turn', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'browser_goto'),
        assistantToolCall('tc-2', 'browser_snapshot'),
      ]),
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(false);
  });

  it('nudges once the current turn used 3+ distinct non-task tools', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'browser_goto'),
        assistantToolCall('tc-2', 'browser_snapshot'),
        assistantToolCall('tc-3', 'browser_click'),
      ]),
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(true);
  });

  it('counts distinct tool call ids, not repeated results', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [assistantToolCall('tc-1', 'browser_goto')]),
      msg('tool', []),
      msg('assistant', [assistantToolCall('tc-1', 'browser_goto')]),
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(false);
  });

  it('never nudges when a task tool call exists anywhere in history', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-t1', 'task_write'),
      ]),
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'browser_goto'),
        assistantToolCall('tc-2', 'browser_snapshot'),
        assistantToolCall('tc-3', 'browser_click'),
        assistantToolCall('tc-4', 'browser_snapshot'),
      ]),
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(false);
  });

  it('ignores tool activity from before the current turn', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('old-1', 'browser_goto'),
        assistantToolCall('old-2', 'browser_snapshot'),
        assistantToolCall('old-3', 'browser_click'),
      ]),
      msg('user', []),
      msg('assistant', [assistantToolCall('new-1', 'browser_goto')]),
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(false);
  });

  it('reads legacy array content shapes too', () => {
    const messages = [
      { role: 'user', content: 'plan' },
      {
        role: 'assistant',
        content: [
          assistantToolCall('tc-1', 'search_web'),
          assistantToolCall('tc-2', 'read_web_page'),
          assistantToolCall('tc-3', 'search_web'),
        ],
      },
    ];
    expect(getTaskNudgeDecision(messages).nudge).toBe(true);
  });

  it('threshold is configurable and matches the exported constant', () => {
    expect(TASK_NUDGE_TOOL_THRESHOLD).toBe(3);
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'a'),
        assistantToolCall('tc-2', 'b'),
      ]),
    ];
    expect(getTaskNudgeDecision(messages, 2).nudge).toBe(true);
  });
});

describe('createTaskNudgeProcessor', () => {
  const processor = createTaskNudgeProcessor();

  it('has the task-nudge id', () => {
    expect(processor.id).toBe('task-nudge');
  });

  it('injects the reminder system message at the threshold', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'browser_goto'),
        assistantToolCall('tc-2', 'browser_snapshot'),
        assistantToolCall('tc-3', 'browser_click'),
      ]),
    ];
    const result = processor.processInputStep!(
      stepArgs(messages) as never,
    ) as { systemMessages?: { role: string; content: string }[] };

    expect(result?.systemMessages).toHaveLength(1);
    expect(result.systemMessages![0]!.role).toBe('system');
    expect(result.systemMessages![0]!.content).toBe(TASK_NUDGE_MESSAGE);
    expect(TASK_NUDGE_MESSAGE.startsWith(TASK_NUDGE_MARKER)).toBe(true);
  });

  it('does nothing below the threshold or without messages', () => {
    expect(
      processor.processInputStep!(stepArgs([msg('user', [])]) as never),
    ).toBeUndefined();
    expect(processor.processInputStep!({} as never)).toBeUndefined();
  });

  it('keeps existing system messages and does not duplicate the marker', () => {
    const messages = [
      msg('user', []),
      msg('assistant', [
        assistantToolCall('tc-1', 'a'),
        assistantToolCall('tc-2', 'b'),
        assistantToolCall('tc-3', 'c'),
      ]),
    ];
    const existing = [
      { role: 'system', content: 'base instruction' },
      { role: 'system', content: TASK_NUDGE_MESSAGE },
    ];

    // Marker already present: no injection.
    expect(
      processor.processInputStep!(stepArgs(messages, existing) as never),
    ).toBeUndefined();

    // Marker absent: appended after existing messages.
    const result = processor.processInputStep!(
      stepArgs(messages, [existing[0]]) as never,
    ) as { systemMessages?: { content: string }[] };
    expect(result.systemMessages).toHaveLength(2);
    expect(result.systemMessages![0]!.content).toBe('base instruction');
    expect(result.systemMessages![1]!.content).toBe(TASK_NUDGE_MESSAGE);
  });

  it('task tool names suppress the nudge across the full set', () => {
    for (const name of TASK_TOOL_NAMES) {
      const messages = [
        msg('user', []),
        msg('assistant', [
          assistantToolCall('tc-1', 'a'),
          assistantToolCall('tc-2', 'b'),
          assistantToolCall('tc-3', 'c'),
          assistantToolCall('tc-t', name),
        ]),
      ];
      expect(getTaskNudgeDecision(messages).nudge).toBe(false);
    }
  });
});
