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
 * Flip every still-running tool card to `interrupted`. Used optimistically
 * right after the user requests a stop: the server-side abort only lands at
 * the next engine step boundary (an in-flight tool call is not interrupted
 * by the durable runtime), so without this the card can keep spinning until
 * the terminal event arrives. A late `tool-result` still upserts over the
 * interrupted state, so a tool that completes anyway renders correctly.
 */
export function interruptRunningToolParts(
  parts: AssistantPart[],
): AssistantPart[] {
  return parts.map((part) =>
    part.type === 'tool' && part.status === 'running'
      ? { ...part, status: 'interrupted' as ToolEventStatus }
      : part,
  );
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

/**
 * A tool outcome harvested from a separate persisted row (legacy V1 storage
 * writes `tool-result` parts under a `role: 'tool'` row keyed by the calling
 * assistant row's `tool-call`). Keyed by `toolCallId`.
 */
export type FlatToolResult = {
  status: ToolEventStatus;
  result?: unknown;
};

/**
 * Unwrap a persisted tool-result `output` (AI SDK v2
 * `LanguageModelV2ToolResultOutput`) to its inner value and detect error
 * variants so restored cards render with the right status.
 */
function unwrapToolOutput(
  output: unknown,
): { value: unknown; error: boolean } {
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    const type = rec.type;
    if (typeof type === 'string' && 'value' in rec) {
      return {
        value: rec.value,
        error: type === 'error-text' || type === 'error-json',
      };
    }
  }
  return { value: output, error: false };
}

function flatString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function restoredToolStatus(invocation: Record<string, unknown>): ToolEventStatus {
  // The abort-persistence bridge stamps synthetic interrupted outcomes with
  // `interrupted: true` inside the tool invocation: the run was stopped
  // while the tool was in flight, so the card must not render as an error
  // even though the persisted state is `output-error` (that state carries
  // the errorText result the next provider request needs for validity).
  if (invocation.interrupted === true) {
    return 'interrupted';
  }
  if (typeof invocation.errorText === 'string' && invocation.errorText) {
    return 'error';
  }
  switch (invocation.state) {
    case 'result':
      return 'complete';
    case 'output-error':
      return 'error';
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
 * Rebuild an assistant turn's ordered parts from persisted Memory content,
 * resolving either shape: Mastra V2 rows wrap parts in
 * `content: { format: 2, parts: [...] }` while legacy V1 rows keep parts as a
 * plain array on `content` (with `tool-result` outcomes sometimes stored under
 * a separate `role: 'tool'` row — supplied via `flatToolResults`). Only `text`,
 * `tool-invocation`, and legacy `tool-call`/`tool-result` parts are kept —
 * reasoning is never surfaced and step/source/file/data parts have no timeline
 * representation yet. Returns undefined when the payload carries no parts so
 * legacy text-only formats can fall back to plain text extraction.
 */
export function restoreAssistantParts(
  content: unknown,
  idPrefix: string,
  flatToolResults?: ReadonlyMap<string, FlatToolResult>,
): RestoredAssistantTurn | undefined {
  const record =
    content && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : undefined;
  const partsList: unknown[] | undefined = Array.isArray(content)
    ? content
    : record && Array.isArray(record.parts)
      ? (record.parts as unknown[])
      : undefined;
  if (!partsList) return undefined;

  let parts: AssistantPart[] = [];
  const texts: string[] = [];
  let counter = 0;

  for (const entry of partsList) {
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
      continue;
    }

    // Legacy V1 flat parts. `tool-call` creates the card at its chronological
    // position; a same-row `tool-result` (or the cross-row outcome passed via
    // `flatToolResults`) finalizes it in place through the same
    // toolCallId-keyed upsert the live stream uses.
    if (part.type === 'tool-call' || part.type === 'tool-result') {
      const toolCallId = flatString(part.toolCallId);
      if (!toolCallId) continue;
      const toolName = flatString(part.toolName);

      if (part.type === 'tool-call') {
        const flat = flatToolResults?.get(toolCallId);
        parts = upsertToolPart(parts, {
          toolCallId,
          ...(toolName !== undefined ? { toolName } : {}),
          status: flat ? flat.status : 'interrupted',
          ...(part.input !== undefined || part.args !== undefined
            ? { args: part.input ?? part.args }
            : {}),
          ...(flat?.result !== undefined ? { result: flat.result } : {}),
        });
        continue;
      }

      // The abort-persistence bridge stamps synthetic results with
      // `interrupted: true` (legacy raw parts carried the flag on the part
      // itself): the tool did not fail, the run was stopped while it was in
      // flight, so the restored card must say interrupted.
      const { value, error } = unwrapToolOutput(part.output ?? part.result);
      parts = upsertToolPart(parts, {
        toolCallId,
        ...(toolName !== undefined ? { toolName } : {}),
        status:
          part.interrupted === true
            ? 'interrupted'
            : error
              ? 'error'
              : 'complete',
        result: value,
      });
    }
  }

  let text = texts.join('\n');
  if (!text && typeof record?.content === 'string' && record.content) {
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
