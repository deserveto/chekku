import { createOwnedThreadId, isOwnedThreadId } from './thread-id';
import { MAIN_AGENT_ID } from './types';

const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ChatQuery = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeAgentId(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate && AGENT_ID.test(candidate) ? candidate : MAIN_AGENT_ID;
}

export function buildChatHref(agentId: string, threadId: string): string {
  const query = new URLSearchParams({ thread: threadId, agent: agentId });
  return `/chat?${query.toString()}`;
}

export function resolveChatIdentity(
  query: ChatQuery,
  resourceId: string,
  uuid?: string,
): {
  agentId: string;
  threadId: string;
  canonicalHref: string;
  generated: boolean;
} {
  const agentId = normalizeAgentId(first(query.agent));
  const requestedThread = first(query.thread)?.trim();
  const owned = requestedThread
    ? isOwnedThreadId(requestedThread, agentId, resourceId)
    : false;
  const threadId = owned
    ? requestedThread!
    : createOwnedThreadId(agentId, resourceId, uuid);

  return {
    agentId,
    threadId,
    canonicalHref: buildChatHref(agentId, threadId),
    generated: !owned,
  };
}
