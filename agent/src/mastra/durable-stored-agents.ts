import { Mastra } from '@mastra/core/mastra';
import { createDurableAgent, isDurableAgent } from '@mastra/core/agent/durable';
import type { Agent, ToolsInput } from '@mastra/core/agent';

/**
 * Task D Fase 3 — durable execution for stored (user-created) agents.
 *
 * Stored agents are hydrated by `MastraEditor` from the database and
 * registered through `mastra.addAgent(agent, id, { source: 'stored' })`
 * (`@mastra/editor` `createAgentFromStoredConfig`). The editor's namespace
 * classes are not exported, so the clean Chekku-owned seam is the
 * registration call itself: this `Mastra` subclass wraps every
 * stored-source registration with `createDurableAgent` before handing it to
 * the base class, whose `isDurableAgentLike` path auto-registers the engine
 * workflow, scorers, and Mastra wiring.
 *
 * Lifecycle coverage (all verified against `@mastra/editor`):
 * - `create()` / first `getById()` → hydrate → `addAgent` → durable wrapper
 *   registered under the stored id, so `getAgentById` and the whole `/runs`
 *   surface resolve the wrapper.
 * - `update()` → the editor's `onCacheEvict` calls `removeAgent` first, then
 *   re-hydrates → this override wraps the fresh instance. In-flight runs
 *   keep their direct reference to the previous instance, matching stored
 *   agent update behavior without durability.
 * - Version-preview hydration (`getById({ versionId })`) also calls
 *   `hydrate`, but the live registration still holds the key, so the base
 *   `addAgent` silently skips duplicates — the guard below skips the wrap
 *   too, leaving the live wrapper untouched and minting no throwaway
 *   wrapper for the transient instance.
 * - Code-defined agents never pass `source: 'stored'` (they are wrapped
 *   explicitly at their module definitions), and `applyStoredOverrides`
 *   does not register at all, so neither path is affected.
 *
 * Upgrade note: verified against the pinned `@mastra/core` /
 * `@mastra/editor` versions; re-run the `durable-stored-agents` suite and
 * re-inspect `Mastra#addAgent` duplicate handling whenever either moves.
 */
export class MastraWithDurableStoredAgents extends Mastra {
  override addAgent<A extends Parameters<Mastra['addAgent']>[0]>(
    agent: A,
    key?: string,
    options?: { source?: string },
  ): void {
    if (options?.source !== 'stored' || isDurableAgent(agent)) {
      super.addAgent(agent, key, options as Parameters<Mastra['addAgent']>[2]);
      return;
    }

    const agentKey = key ?? agent.id;
    if (agentKey && this.listAgents()[agentKey] !== undefined) {
      // Duplicate registration (version-preview hydration): the base class
      // would skip it anyway — do not wrap, and do not disturb the live
      // registration.
      super.addAgent(agent, key, options as Parameters<Mastra['addAgent']>[2]);
      return;
    }

    // The factory's `agent` parameter leaves the request-context generic at
    // `unknown` while hydrated stored agents carry the editor's context
    // shape; the runtime shapes are identical (same contravariance note as
    // the code-defined durable wrappers).
    const wrapped = createDurableAgent({
      agent: agent as Agent<string, ToolsInput, undefined>,
    });
    super.addAgent(wrapped, key, options as Parameters<Mastra['addAgent']>[2]);
  }
}
