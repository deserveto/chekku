import { describe, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createDurableAgent, isDurableAgent } from '@mastra/core/agent/durable';

import { MastraWithDurableStoredAgents } from './durable-stored-agents.js';
import { mastra } from './index.js';

function makeStoredAgent(id: string): Agent {
  return new Agent({
    id,
    name: `Stored ${id}`,
    instructions: 'test agent',
    // A model callback keeps the durable wrapper's eager `getModel()` cheap
    // and offline — it only resolves the id string, never a provider call.
    model: () => 'openai/gateway/test-model',
  });
}

function makeRegistry() {
  return new MastraWithDurableStoredAgents({});
}

describe('durable stored agents (Task D Fase 3)', () => {
  it('wraps a stored-source registration and keeps the public identity', () => {
    const registry = makeRegistry();
    const plain = makeStoredAgent('stored-echo-agent');

    registry.addAgent(plain, 'stored-echo-agent', { source: 'stored' });

    const registered = registry.listAgents()['stored-echo-agent'];
    expect(isDurableAgent(registered)).toBe(true);
    expect(registered).not.toBe(plain);
    // The wrapper preserves the agent's public id so `getAgentById`,
    // thread-id ownership, and the `/runs` surface resolve unchanged.
    expect(registered?.id).toBe('stored-echo-agent');
    expect(registry.getAgentById('stored-echo-agent')).toBe(registered);
  });

  it('leaves the live registration untouched on duplicate keys (version-preview hydration)', () => {
    // MastraEditor's version-preview path (getById with versionId) hydrates
    // a transient instance and calls addAgent again; the base class skips
    // duplicates, and the override must not disturb the live wrapper or
    // mint a throwaway one.
    const registry = makeRegistry();
    const live = makeStoredAgent('stored-echo-agent');
    registry.addAgent(live, 'stored-echo-agent', { source: 'stored' });
    const liveRegistered = registry.listAgents()['stored-echo-agent'];
    expect(isDurableAgent(liveRegistered)).toBe(true);

    const transient = makeStoredAgent('stored-echo-agent');
    registry.addAgent(transient, 'stored-echo-agent', { source: 'stored' });

    expect(registry.listAgents()['stored-echo-agent']).toBe(liveRegistered);
  });

  it('keeps code-defined registrations (no stored source) plain', () => {
    const registry = makeRegistry();
    const plain = makeStoredAgent('code-defined-agent');

    registry.addAgent(plain);

    expect(registry.listAgents()['code-defined-agent']).toBe(plain);
    expect(isDurableAgent(registry.listAgents()['code-defined-agent'])).toBe(false);
  });

  it('does not double-wrap an already durable stored registration', () => {
    const registry = makeRegistry();
    const wrapper = createDurableAgent({ agent: makeStoredAgent('stored-durable-agent') });

    registry.addAgent(wrapper, 'stored-durable-agent', { source: 'stored' });

    expect(registry.listAgents()['stored-durable-agent']).toBe(wrapper);
  });

  it('re-wraps a fresh instance after the update cycle evicts the old entry', () => {
    // MastraEditor.update() evicts (removeAgent) then re-hydrates; the
    // override must wrap the fresh instance so updated configs run durable.
    const registry = makeRegistry();
    registry.addAgent(makeStoredAgent('stored-echo-agent'), 'stored-echo-agent', { source: 'stored' });
    const first = registry.listAgents()['stored-echo-agent'];
    expect(isDurableAgent(first)).toBe(true);

    expect(registry.removeAgent('stored-echo-agent')).toBe(true);
    expect(registry.listAgents()['stored-echo-agent']).toBeUndefined();

    const fresh = makeStoredAgent('stored-echo-agent');
    registry.addAgent(fresh, 'stored-echo-agent', { source: 'stored' });

    const second = registry.listAgents()['stored-echo-agent'];
    expect(isDurableAgent(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(second?.id).toBe('stored-echo-agent');
  });

  it('composes the runtime with the durable stored-agent registry', () => {
    // The composition root must use the subclass; code-defined wrappers
    // (Fase 1 & 2) still register through the same addAgent path untouched.
    expect(mastra).toBeInstanceOf(MastraWithDurableStoredAgents);
    expect(mastra.getAgentById('pm-agent').id).toBe('pm-agent');
  });
});
