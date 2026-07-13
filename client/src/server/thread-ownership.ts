const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THREAD_ID = /^[A-Za-z0-9_-]+$/;

export function threadPrefix(agentId: string, resourceId: string): string {
  if (!AGENT_ID.test(agentId) || agentId.length > 100) throw new Error('Invalid agent id');
  if (!THREAD_ID.test(resourceId) || resourceId.length > 80) throw new Error('Invalid resource id');
  return `${agentId}-${resourceId}-`;
}

export function assertOwnedThread(agentId: string, resourceId: string, threadId: string): void {
  if (!THREAD_ID.test(threadId) || threadId.length > 200) throw new Error('FORBIDDEN');
  if (!threadId.startsWith(threadPrefix(agentId, resourceId))) throw new Error('FORBIDDEN');
}
