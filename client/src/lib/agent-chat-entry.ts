import { listAgentThreads } from '@/lib/memory-threads';
import { loadModelRegistry } from '@/lib/model-registry';
import { createOwnedThreadId } from '@/lib/thread-id';
import { ensureStoredAgentUsesServerGateway } from '@/lib/stored-agents';
import type { ChekkuAgentSummary } from '@/lib/types';

/**
 * Resolves the thread an "Open chat" action should land on: the agent's
 * most recent Memory thread, or a fresh owned thread when the agent has no
 * history yet. Stored agents are migrated to the server gateway first so
 * the chat opens against a runnable model.
 */
export async function resolveAgentChatThreadId(
  resourceId: string,
  target: ChekkuAgentSummary,
): Promise<string> {
  const modelRegistry = await loadModelRegistry();
  await ensureStoredAgentUsesServerGateway(target, modelRegistry);
  const threads = await listAgentThreads(resourceId, target.id).catch(
    () => [],
  );
  const latest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest ? latest.id : createOwnedThreadId(target.id, resourceId);
}
