const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Agent-side mirror of the client thread-ID ownership contract
 * (`client/src/lib/thread-id.ts`). The agent server never imports client
 * code, so the rule is restated here and locked by tests on both sides:
 * a thread ID must look like `{agentId}-{resourceId}-{uuid}`.
 */
export function isOwnedThreadId(
  threadId: string,
  agentId: string,
  resourceId: string,
): boolean {
  if (!AGENT_ID.test(agentId) || agentId.length > 100) return false;
  if (!RESOURCE_ID.test(resourceId) || resourceId.length > 80) return false;
  return threadId.startsWith(`${agentId}-${resourceId}-`);
}

export function isAgentId(value: string): boolean {
  return AGENT_ID.test(value) && value.length <= 100;
}

export function isResourceId(value: string): boolean {
  return RESOURCE_ID.test(value) && value.length <= 80;
}
