const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]+$/;

function assertAgentId(value: string): void {
  if (!AGENT_ID.test(value) || value.length > 100) {
    throw new Error('agentId must use lowercase kebab-case');
  }
}

function assertResourceId(value: string): void {
  if (!RESOURCE_ID.test(value) || value.length > 80) {
    throw new Error('resourceId contains unsupported characters');
  }
}

export function threadPrefix(agentId: string, resourceId: string): string {
  assertAgentId(agentId);
  assertResourceId(resourceId);
  return `${agentId}-${resourceId}-`;
}

export function createOwnedThreadId(
  agentId: string,
  resourceId: string,
  uuid: string = crypto.randomUUID(),
): string {
  return `${threadPrefix(agentId, resourceId)}${uuid}`;
}

export function isOwnedThreadId(
  threadId: string,
  agentId: string,
  resourceId: string,
): boolean {
  try {
    return threadId.startsWith(threadPrefix(agentId, resourceId));
  } catch {
    return false;
  }
}
