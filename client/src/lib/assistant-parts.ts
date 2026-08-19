import type {
  AssistantPart,
  TextAssistantPart,
  ToolAssistantPart,
  ToolEventStatus,
} from './types';

export type ToolPartUpdate = {
  toolCallId: string;
  toolName?: string;
  status: ToolEventStatus;
  args?: unknown;
  result?: unknown;
  runId?: string;
};

/**
 * Append a streamed text delta to an assistant turn's parts. Adjacent deltas
 * merge into the trailing text part so one logical text block stays one DOM
 * subtree; a delta that arrives after a tool part starts a new text part,
 * which is what preserves chronological ordering.
 */
export function appendTextDelta(
  parts: AssistantPart[],
  text: string,
): AssistantPart[] {
  if (text === '') return parts;

  const last = parts[parts.length - 1];

  if (last && last.type === 'text') {
    const copy = parts.slice();
    copy[copy.length - 1] = {
      ...last,
      content: last.content + text,
    };
    return copy;
  }

  return [
    ...parts,
    {
      type: 'text',
      id: crypto.randomUUID(),
      content: text,
    },
  ];
}

/**
 * Insert or update one tool part keyed by `toolCallId`. The first event
 * (usually `tool-call`) creates a running card at the current timeline
 * position; later events (`tool-result` / `tool-error`) update that same
 * part in place instead of appending a duplicate. Only defined fields
 * overwrite, so a result event never wipes the args captured earlier.
 */
export function upsertToolPart(
  parts: AssistantPart[],
  update: ToolPartUpdate,
): AssistantPart[] {
  const index = parts.findIndex(
    (part) => part.type === 'tool' && part.toolCallId === update.toolCallId,
  );

  if (index === -1) {
    return [
      ...parts,
      {
        type: 'tool',
        id: crypto.randomUUID(),
        toolCallId: update.toolCallId,
        toolName: update.toolName ?? 'tool',
        status: update.status,
        ...(update.args !== undefined ? { args: update.args } : {}),
        ...(update.result !== undefined ? { result: update.result } : {}),
        ...(update.runId !== undefined ? { runId: update.runId } : {}),
      },
    ];
  }

  const existing = parts[index];

  if (existing.type !== 'tool') return parts;

  const copy = parts.slice();
  copy[index] = {
    ...existing,
    status: update.status,
    ...(update.toolName !== undefined
      ? { toolName: update.toolName }
      : {}),
    ...(update.args !== undefined ? { args: update.args } : {}),
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.runId !== undefined ? { runId: update.runId } : {}),
  };
  return copy;
}

export type AssistantPartGroup =
  | { kind: 'text'; part: TextAssistantPart }
  | { kind: 'tools'; parts: ToolAssistantPart[] };

/**
 * Collapse ordered parts into renderable groups: consecutive tool parts form
 * one run rendered inside a single `.chat-tool-timeline`, text parts stand
 * alone between runs. Grouping keeps the existing card-cluster visuals for
 * back-to-back tool calls while placing each run at its chronological point.
 */
export function groupAssistantParts(
  parts: AssistantPart[],
): AssistantPartGroup[] {
  const groups: AssistantPartGroup[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      groups.push({ kind: 'text', part });
      continue;
    }

    const last = groups[groups.length - 1];
    if (last && last.kind === 'tools') {
      last.parts.push(part);
    } else {
      groups.push({ kind: 'tools', parts: [part] });
    }
  }

  return groups;
}

export type RestoredAssistantTurn = {
  /** Concatenated text of the turn, matching what live streaming keeps in sync. */
  text: string;
  /** Chronological parts including tool calls, or empty when none survive. */
  parts: AssistantPart[];
};

function restoredToolStatus(invocation: Record<string, unknown>): ToolEventStatus {
  if (typeof invocation.errorText === 'string' && invocation.errorText) {
    return 'error';
  }
  switch (invocation.state) {
    case 'result':
      return 'complete';
    case 'approval-requested':
      return 'approval';
    case 'declined':
      return 'declined';
    default:
      return 'interrupted';
  }
}

function restoredToolPart(
  invocation: unknown,
  id: string,
): ToolAssistantPart | undefined {
  if (!invocation || typeof invocation !== 'object') return undefined;
  const record = invocation as Record<string, unknown>;
  if (typeof record.toolCallId !== 'string' || !record.toolCallId) {
    return undefined;
  }

  const errorText =
    typeof record.errorText === 'string' && record.errorText
      ? record.errorText
      : undefined;

  return {
    type: 'tool',
    id,
    toolCallId: record.toolCallId,
    toolName:
      typeof record.toolName === 'string' && record.toolName
        ? record.toolName
        : 'tool',
    status: restoredToolStatus(record),
    ...(record.args !== undefined ? { args: record.args } : {}),
    ...(record.result !== undefined
      ? { result: record.result }
      : errorText !== undefined
        ? { result: errorText }
        : {}),
  };
}

/**
 * Rebuild an assistant turn's ordered parts from a Mastra Memory V2 message
 * (`content: { format: 2, parts: [...] }`). Only `text` and
 * `tool-invocation` parts are kept — reasoning is never surfaced and
 * step/source/file/data parts have no timeline representation yet. Returns
 * undefined when the payload carries no `parts` array so legacy formats can
 * fall back to plain text extraction.
 */
export function restoreAssistantParts(
  content: unknown,
  idPrefix: string,
): RestoredAssistantTurn | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const record = content as Record<string, unknown>;
  if (!Array.isArray(record.parts)) return undefined;

  const parts: AssistantPart[] = [];
  const texts: string[] = [];
  let counter = 0;

  for (const entry of record.parts) {
    if (!entry || typeof entry !== 'object') continue;
    const part = entry as Record<string, unknown>;

    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      texts.push(part.text);
      parts.push({
        type: 'text',
        id: `${idPrefix}-x${counter++}`,
        content: part.text,
      });
      continue;
    }

    if (part.type === 'tool-invocation') {
      const tool = restoredToolPart(part.toolInvocation, `${idPrefix}-t${counter++}`);
      if (tool) parts.push(tool);
    }
  }

  let text = texts.join('\n');
  if (!text && typeof record.content === 'string' && record.content) {
    text = record.content;
    parts.push({
      type: 'text',
      id: `${idPrefix}-x${counter++}`,
      content: record.content,
    });
  }

  return { text, parts };
}

export function textFromAssistantParts(parts: AssistantPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.content : ''))
    .filter(Boolean)
    .join('\n');
}

export type MergeableTurnMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  parts?: AssistantPart[];
  createdAt: number;
};

/**
 * Merge runs of consecutive assistant rows into one logical turn. Mastra
 * persists one assistant row per step (response boundaries between state
 * signals disable write-time merging), while a chat turn must render as a
 * single response. Parts concatenate in row order, text joins with a
 * newline, and the first row's id/createdAt become the turn's. A user row
 * always starts a new turn.
 */
export function mergeAdjacentAssistantTurns<T extends MergeableTurnMessage>(
  messages: T[],
): T[] {
  const merged: T[] = [];

  for (const message of messages) {
    const last = merged[merged.length - 1];

    if (message.role === 'assistant' && last?.role === 'assistant') {
      const parts = [...(last.parts ?? []), ...(message.parts ?? [])];
      merged[merged.length - 1] = {
        ...last,
        content: [last.content, message.content]
          .filter(Boolean)
          .join('\n'),
        ...(parts.length ? { parts } : {}),
      };
      continue;
    }

    merged.push(message);
  }

  return merged;
}
