import { mastraClient } from './mastra-client';
import {
  mergeAdjacentAssistantTurns,
  restoreAssistantParts,
  type FlatToolResult,
} from './assistant-parts';
import { stripAttachmentBlocks } from './chat-attachments';
import type { AssistantPart } from './types';
import { isOwnedThreadId } from './thread-id';

export interface StudioThread {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface StudioMemoryAttachment {
  mimeType: string;
  dataUrl: string;
  filename?: string;
}

export interface StudioMemoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Chronological assistant-turn parts rebuilt from Mastra Memory's stored
   * `tool-invocation` parts, so restored threads keep their tool call
   * timeline. Absent for user messages and turns without tool activity.
   */
  parts?: AssistantPart[];
  createdAt: number;
  attachments?: StudioMemoryAttachment[];
}

const MAX_RESTORED_ATTACHMENTS = 24;
/**
 * Restore-path byte bounds. Postgres can hold attachment payloads far larger
 * than anything worth materializing as `data:` URLs in the browser, so thread
 * reads skip oversized payloads and stop once the per-message or per-thread
 * budgets are exhausted. The per-attachment bound matches the send-side total
 * base64 cap; skipping (not truncating) keeps broken images out of the UI.
 */
const MAX_RESTORED_ATTACHMENT_CHARS = 8 * 1024 * 1024;
const MAX_RESTORED_MESSAGE_ATTACHMENT_CHARS = 8 * 1024 * 1024;
const MAX_RESTORED_THREAD_ATTACHMENT_CHARS = 24 * 1024 * 1024;
/**
 * Display text cap per restored message. Live user bubbles only ever show the
 * typed prompt; legacy rows without attachment sentinels can still carry the
 * full wrapped blob, so the restore path bounds what it renders.
 */
const MAX_RESTORED_TEXT_CHARS = 128 * 1024;

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
    if (Array.isArray(record.parts)) return textFromContent(record.parts);
  }

  return '';
}

/** Constant fallback title rendered for threads the server has not titled
 * yet; ChatStudio compares against it when deciding on delayed refreshes. */
export const UNTITLED_THREAD_LABEL = 'New conversation';

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
        : UNTITLED_THREAD_LABEL,
    agentId:
      typeof row.agentId === 'string' && row.agentId
        ? row.agentId
        : fallbackAgentId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt, toTimestamp(row.createdAt)),
  };
}

function attachmentsFromContent(
  content: unknown,
  budget: { remaining: number },
): StudioMemoryAttachment[] {
  const attachments: StudioMemoryAttachment[] = [];
  let messageTotal = 0;
  for (const part of partsFromContent(content)) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type !== 'file') continue;
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
    if (!mimeType.startsWith('image/')) continue;
    const data = typeof record.data === 'string' ? record.data : '';
    if (!data) continue;
    const chars = data.length;
    if (chars > MAX_RESTORED_ATTACHMENT_CHARS) continue;
    if (messageTotal + chars > MAX_RESTORED_MESSAGE_ATTACHMENT_CHARS) break;
    if (budget.remaining - chars < 0) break;
    messageTotal += chars;
    budget.remaining -= chars;
    attachments.push({
      mimeType,
      dataUrl: data.startsWith('data:') ? data : `data:${mimeType};base64,${data}`,
      ...(typeof record.filename === 'string' && record.filename
        ? { filename: record.filename }
        : {}),
    });
    if (attachments.length >= MAX_RESTORED_ATTACHMENTS) break;
  }
  return attachments;
}

function clampRestoredText(text: string): string {
  if (text.length <= MAX_RESTORED_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_RESTORED_TEXT_CHARS)}…[message truncated]`;
}

function normalizeMessage(
  value: unknown,
  flatToolResults?: ReadonlyMap<string, FlatToolResult>,
  attachmentBudget: { remaining: number } = { remaining: MAX_RESTORED_THREAD_ATTACHMENT_CHARS },
): StudioMemoryMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const role = row.role;

  if (role !== 'user' && role !== 'assistant') return undefined;

  const id =
    typeof row.id === 'string' && row.id
      ? row.id
      : crypto.randomUUID();

  const restored =
    role === 'assistant'
      ? restoreAssistantParts(row.content, id, flatToolResults)
      : undefined;
  // User bubbles restore the display prompt: attachment sentinels and the
  // wrapped file bodies they delimit are transport, not chat display.
  const content =
    role === 'user'
      ? clampRestoredText(stripAttachmentBlocks(textFromContent(row.content)))
      : restored
        ? restored.text
        : textFromContent(row.content);
  const parts = restored?.parts.length ? restored.parts : undefined;
  const attachments = attachmentsFromContent(row.content, attachmentBudget);
  if (!content && !parts && role === 'assistant') return undefined;
  if (role === 'user' && !content && attachments.length === 0) return undefined;

  return {
    id,
    role,
    content,
    ...(parts ? { parts } : {}),
    createdAt: toTimestamp(row.createdAt),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Resolve the message parts from either persisted shape: legacy V1 rows keep
 * parts as a plain array on `content`, while Mastra V2 rows wrap them in
 * `content: { format: 2, parts: [...] }`.
 */
function partsFromContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (content && typeof content === 'object') {
    const parts = (content as Record<string, unknown>).parts;
    if (Array.isArray(parts)) return parts;
  }
  return [];
}

/**
 * Harvest legacy V1 `tool-result` outcomes from every raw memory row (they
 * persist under separate `role: 'tool'` rows, keyed by the calling assistant
 * row's `tool-call` part) so the assistant turn's card can be finalized with
 * its outcome and status.
 */
function collectFlatToolResults(
  rows: unknown[],
): Map<string, FlatToolResult> {
  const results = new Map<string, FlatToolResult>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;

    for (const part of partsFromContent(rec.content)) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type !== 'tool-result') continue;
      const toolCallId =
        typeof p.toolCallId === 'string' ? p.toolCallId : '';
      if (!toolCallId) continue;

      const output = p.output ?? p.result;
      // The abort-persistence bridge stamps synthetic results with
      // `interrupted: true`; that marker outranks the error-text output it
      // is persisted with — the tool was stopped, not failed.
      const interrupted = p.interrupted === true;
      let status: FlatToolResult['status'] = 'complete';
      let value: unknown = output;
      if (output && typeof output === 'object') {
        const out = output as Record<string, unknown>;
        if (typeof out.type === 'string' && 'value' in out) {
          value = out.value;
          status =
            out.type === 'error-text' || out.type === 'error-json'
              ? 'error'
              : 'complete';
        }
      }
      if (interrupted) status = 'interrupted';

      results.set(toolCallId, {
        status,
        ...(value !== undefined ? { result: value } : {}),
      });
    }
  }

  return results;
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

  const rowArray = rows;
  const flatToolResults = collectFlatToolResults(rowArray);
  const attachmentBudget = { remaining: MAX_RESTORED_THREAD_ATTACHMENT_CHARS };

  return mergeAdjacentAssistantTurns(
    rowArray
      .map((row) => normalizeMessage(row, flatToolResults, attachmentBudget))
      .filter((row): row is StudioMemoryMessage => Boolean(row))
      .sort((a, b) => a.createdAt - b.createdAt),
  );
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
