import { randomUUID } from 'node:crypto';

/**
 * Memory threading for direct durable-agent `.generate()` calls.
 *
 * The pinned `@mastra/core` 1.50.1 durable engine runs every configured
 * input processor's `computeStateSignal` at each LLM step, and the built-in
 * task-state processor (created by `signals: createTaskSignals()`) requires
 * a memory thread — a durable run invoked without one fails its LLM step.
 * The two workflow call sites that invoke durable wrappers directly
 * (`weekly-social-drafts` → supervisor, `generate-social-post-visual` →
 * Visual Content Agent) pass these options so their runs always carry a
 * synthetic thread under the reserved `delegation` resource. Those threads
 * never surface in the client (thread listings filter by the session user's
 * resourceId) and match the canonical `{agentId}-{resourceId}-{uuid}` shape.
 *
 * Delegation through the supervisor's `agents` field does NOT use this
 * helper: core's network delegation wrapper reads `messageList`/`text` off
 * the sub-agent stream result, which `DurableAgent.stream()` does not
 * expose — delegation targets must stay plain instances.
 *
 * Remove this module only when a future `@mastra/core` makes threadless
 * durable runs safe (or delegation durable-compatible).
 */

const DELEGATION_RESOURCE_ID = 'delegation';

export interface DurableRunMemoryOptions {
  memory: { thread: string; resource: string };
}

export function createDurableRunMemoryOptions(agentId: string): DurableRunMemoryOptions {
  return {
    memory: {
      thread: `${agentId}-${DELEGATION_RESOURCE_ID}-${randomUUID()}`,
      resource: DELEGATION_RESOURCE_ID,
    },
  };
}
