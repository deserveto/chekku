import type { InputProcessor, ProcessInputStepResult } from '@mastra/core/processors';
import { TASK_TOOL_NAMES } from './task-signals.js';

/**
 * Advisory spawn-reliability processor: the live QA run showed the model
 * skipping task tracking on genuinely multi-step prompts when nothing
 * forces the decision. `TASK_GUIDANCE` steers at turn start; this guard
 * closes the mid-run gap — once the current turn has already used several
 * distinct tools and no task tool call exists anywhere in the conversation,
 * it injects a one-shot system reminder telling the model to call
 * `task_write` (or to ignore the reminder if the work is simple).
 *
 * Deterministic properties:
 * - Never fires before the threshold of distinct non-task tool calls in the
 *   CURRENT turn (slice from the last user message), so trivial turns never
 *   see a reminder.
 * - Never fires once any task tool call exists in the conversation history
 *   (the model already tracks tasks, or a previous turn did).
 * - The reminder text carries a marker; if the marker is already present in
 *   the step's system messages it is not appended again.
 * - Advisory only: it never blocks, trips, or rewrites tool access.
 */

export const TASK_NUDGE_MARKER = '[chekku:task-reminder]';

export const TASK_NUDGE_MESSAGE = `${TASK_NUDGE_MARKER} Several tools were already used in this turn and no task list exists. If the remaining work involves 3 or more distinct steps, call task_write now with the full plan, keep exactly one task in_progress at a time, and mark tasks completed immediately after finishing them. If the work is simple or nearly done, ignore this reminder and continue.`;

/** Distinct non-task tool calls in the current turn before nudging. */
export const TASK_NUDGE_TOOL_THRESHOLD = 3;

interface ToolInvocationPart {
  type?: string;
  toolInvocation?: {
    toolCallId?: string;
    toolName?: string;
  };
}

interface StepMessage {
  role?: string;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractParts(message: StepMessage): ToolInvocationPart[] {
  const content = message?.content;
  if (Array.isArray(content)) return content as ToolInvocationPart[];
  if (isRecord(content) && Array.isArray(content.parts)) {
    return content.parts as ToolInvocationPart[];
  }
  return [];
}

function sliceCurrentTurn(messages: readonly StepMessage[]): readonly StepMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return messages.slice(i);
    }
  }
  return messages;
}

export interface TaskNudgeDecision {
  nudge: boolean;
}

export function getTaskNudgeDecision(
  messages: readonly StepMessage[],
  threshold: number = TASK_NUDGE_TOOL_THRESHOLD,
): TaskNudgeDecision {
  let hasTaskCall = false;
  const currentTurnToolIds = new Set<string>();

  const currentTurn = sliceCurrentTurn(messages);
  const currentTurnStart = messages.length - currentTurn.length;

  messages.forEach((message, index) => {
    for (const part of extractParts(message)) {
      const invocation = part?.toolInvocation;
      if (!invocation || typeof invocation.toolName !== 'string') continue;
      if (part.type !== 'tool-invocation' && part.type !== 'tool-call') {
        continue;
      }
      if (TASK_TOOL_NAMES.has(invocation.toolName)) {
        hasTaskCall = true;
        continue;
      }
      if (index >= currentTurnStart && typeof invocation.toolCallId === 'string') {
        currentTurnToolIds.add(invocation.toolCallId);
      }
    }
  });

  return { nudge: !hasTaskCall && currentTurnToolIds.size >= threshold };
}

export function createTaskNudgeProcessor(): InputProcessor {
  return {
    id: 'task-nudge',
    processInputStep: (args) => {
      const raw = args as {
        messages?: unknown;
        messageList?: { get?: { all?: { db?: () => unknown } } };
        systemMessages?: unknown[];
      };
      const messageSource = raw.messages ?? raw.messageList?.get?.all?.db?.();
      const messages = Array.isArray(messageSource)
        ? (messageSource as StepMessage[])
        : [];

      if (!getTaskNudgeDecision(messages).nudge) return;

      const existingSystemMessages = Array.isArray(raw.systemMessages)
        ? raw.systemMessages
        : [];
      const alreadyNudged = existingSystemMessages.some((message) => {
        const content = isRecord(message) ? message.content : message;
        return typeof content === 'string' && content.includes(TASK_NUDGE_MARKER);
      });
      if (alreadyNudged) return;

      return {
        systemMessages: [
          ...existingSystemMessages,
          { role: 'system', content: TASK_NUDGE_MESSAGE },
        ],
      } as ProcessInputStepResult;
    },
  };
}
