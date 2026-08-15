import { mastraClient } from './mastra-client';
import { isOwnedThreadId } from './thread-id';
import type { ToolEvent, ToolEventStatus } from './types';

export interface StudioThread {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface StudioMemoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface StudioThreadMessages {
  messages: StudioMemoryMessage[];
  toolEvents: ToolEvent[];
}

function toTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  if (value instanceof Date) return value.getTime();
  return fallback;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }

  return '';
}

function normalizeThread(
  value: unknown,
  fallbackAgentId: string,
): StudioThread | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const id =
    typeof row.id === 'string'
      ? row.id
      : typeof row.threadId === 'string'
        ? row.threadId
        : '';

  if (!id) return undefined;

  return {
    id,
    title:
      typeof row.title === 'string' && row.title.trim()
        ? row.title
        : 'New conversation',
    agentId:
      typeof row.agentId === 'string' && row.agentId
        ? row.agentId
        : fallbackAgentId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt, toTimestamp(row.createdAt)),
  };
}

function normalizeMessage(value: unknown): StudioMemoryMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const role = row.role;

  if (role !== 'user' && role !== 'assistant') return undefined;

  const content = textFromContent(row.content);
  // Keep assistant messages that carry tool-call parts even when they have no
  // text body — their tool cards need a parent message to render under. Drop
  // only truly empty assistant messages.
  const hasToolParts = messageHasToolParts(row.content);
  if (!content && role === 'assistant' && !hasToolParts) return undefined;

  return {
    id:
      typeof row.id === 'string' && row.id
        ? row.id
        : crypto.randomUUID(),
    role,
    content,
    createdAt: toTimestamp(row.createdAt),
  };
}

function messageHasToolParts(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as Record<string, unknown>).type;
    return type === 'tool-call' || type === 'tool-result';
  });
}

/**
 * Unwrap a persisted tool-result `output` (AI SDK v5
 * `LanguageModelV2ToolResultOutput`) to its inner value and detect error
 * variants so restored cards can render with the right status.
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

/**
 * Harvest tool-call and tool-result parts from every raw memory row (any role)
 * and merge them by `toolCallId` into `ToolEvent` records. Each event is
 * attached to the assistant message that emitted the tool call so it renders
 * under the right chat bubble after a reload.
 */
function extractToolEvents(rows: unknown[]): ToolEvent[] {
  const byCallId = new Map<string, ToolEvent>();
  const order: string[] = [];

  const touch = (toolCallId: string, init: ToolEvent): ToolEvent => {
    const existing = byCallId.get(toolCallId);
    if (existing) return existing;
    byCallId.set(toolCallId, init);
    order.push(toolCallId);
    return init;
  };

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const messageId = typeof rec.id === 'string' ? rec.id : '';
    const role = rec.role;
    const parts = Array.isArray(rec.content) ? rec.content : [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const type = p.type;
      const toolCallId =
        typeof p.toolCallId === 'string' ? p.toolCallId : '';
      if (!toolCallId) continue;
      const toolName =
        typeof p.toolName === 'string' && p.toolName ? p.toolName : 'tool';

      if (type === 'tool-call') {
        const event = touch(toolCallId, {
          id: toolCallId,
          messageId: role === 'assistant' ? messageId : '',
          toolCallId,
          toolName,
          status: 'running',
          args: p.input ?? p.args,
        });
        if (!event.messageId && role === 'assistant') {
          event.messageId = messageId;
        }
        if (event.args === undefined) {
          event.args = p.input ?? p.args;
        }
        if (event.toolName === 'tool' && toolName !== 'tool') {
          event.toolName = toolName;
        }
      } else if (type === 'tool-result') {
        const { value, error } = unwrapToolOutput(p.output ?? p.result);
        const status: ToolEventStatus = error ? 'error' : 'complete';
        const event = touch(toolCallId, {
          id: toolCallId,
          messageId: role === 'assistant' ? messageId : '',
          toolCallId,
          toolName,
          status,
          result: value,
        });
        event.result = value;
        event.status = status;
        if (event.toolName === 'tool' && toolName !== 'tool') {
          event.toolName = toolName;
        }
      }
    }
  }

  return order
    .map((id) => byCallId.get(id) as ToolEvent)
    .filter((event) => Boolean(event.messageId));
}

function assertThreadOwnership(
  agentId: string,
  threadId: string,
  resourceId: string,
): void {
  if (!isOwnedThreadId(threadId, agentId, resourceId)) {
    throw new Error('Thread does not belong to this agent and resource');
  }
}

function isThreadNotFoundError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const status = (value as { status?: unknown }).status;
  if (status !== undefined) return status === 404;
  return value.message === 'Thread not found';
}

export async function listAgentThreads(
  resourceId: string,
  agentId: string,
): Promise<StudioThread[]> {
  const response = await mastraClient.listMemoryThreads({
    resourceId,
    agentId,
  });

  const raw = response as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).threads ?? [])
      : [];

  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => normalizeThread(row, agentId))
    .filter((row): row is StudioThread => {
      if (!row) return false;
      return isOwnedThreadId(row.id, agentId, resourceId);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listThreadMessages(
  agentId: string,
  threadId: string,
  resourceId: string,
): Promise<StudioThreadMessages> {
  assertThreadOwnership(agentId, threadId, resourceId);
  const thread = mastraClient.getMemoryThread({ threadId, agentId });
  const response = await thread
    .listMessages({
      page: 0,
      perPage: 200,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    })
    .catch((error: unknown) => {
      if (isThreadNotFoundError(error)) return { messages: [] };
      throw error;
    });

  const raw = response as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).messages ?? [])
      : [];

  const rowArray = Array.isArray(rows) ? rows : [];

  const messages = rowArray
    .map(normalizeMessage)
    .filter((row): row is StudioMemoryMessage => Boolean(row))
    .sort((a, b) => a.createdAt - b.createdAt);

  const toolEvents = extractToolEvents(rowArray);

  return { messages, toolEvents };
}

export async function renameThread(
  agentId: string,
  threadId: string,
  resourceId: string,
  title: string,
): Promise<void> {
  assertThreadOwnership(agentId, threadId, resourceId);
  const thread = mastraClient.getMemoryThread({ threadId, agentId });
  const current = await thread.get();
  const metadata =
    current &&
    typeof current === 'object' &&
    'metadata' in current &&
    current.metadata &&
    typeof current.metadata === 'object'
      ? (current.metadata as Record<string, unknown>)
      : {};

  await thread.update({
    title,
    resourceId,
    metadata,
  });
}

export async function removeThread(
  agentId: string,
  threadId: string,
  resourceId: string,
): Promise<void> {
  assertThreadOwnership(agentId, threadId, resourceId);
  const thread = mastraClient.getMemoryThread({ threadId, agentId });
  await thread.delete().catch((error: unknown) => {
    if (isThreadNotFoundError(error)) return;
    throw error;
  });
}
