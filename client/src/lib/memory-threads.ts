import { mastraClient } from './mastra-client';
import { isOwnedThreadId } from './thread-id';

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
  if (!content && role === 'assistant') return undefined;

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
  if (status === 404) return true;
  return /\b404\b|not found/i.test(value.message);
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
): Promise<StudioMemoryMessage[]> {
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

  if (!Array.isArray(rows)) return [];

  return rows
    .map(normalizeMessage)
    .filter((row): row is StudioMemoryMessage => Boolean(row))
    .sort((a, b) => a.createdAt - b.createdAt);
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
  await thread.delete();
}
