import { describe, expect, it } from 'vitest';
import { mastra } from '../../mastra/index.js';
import { TASK_TOOL_NAMES } from '../../mastra/tasks/task-signals.js';
/**
 * Every code-defined agent must carry the Mastra task tools (wired through
 * `signals: createTaskSignals()`), so task tracking is available across the
 * whole studio — not just one agent. Stored/editor agents cannot receive
 * signal providers through the current @mastra/editor hydration path
 * (createAgentFromStoredConfig passes no `signals`), which is why only the
 * composition-root agents are asserted here.
 */
describe('code-defined agents task tool wiring', () => {
  const AGENT_KEYS = [
    'mainAgent',
    'pmAgent',
    'qaWebAgent',
    'qaAndroidAgent',
    'socialMediaContentWriter',
    'socialMediaStrategistAgent',
    'socialMediaSupervisorAgent',
    'visualContentAgent',
  ] as const;

  it('registers every expected code-defined agent', () => {
    for (const key of AGENT_KEYS) {
      expect(mastra.getAgent(key), key).toBeDefined();
    }
  });

  it('exposes the four task tools on every code-defined agent', async () => {
    for (const key of AGENT_KEYS) {
      const agent = mastra.getAgent(key);
      const tools = await agent.getToolsForExecution({
        requestContext: undefined as never,
      });
      for (const toolName of TASK_TOOL_NAMES) {
        expect(tools[toolName], `${key}:${toolName}`).toBeDefined();
      }
    }
  });

  it('embeds the shared task usage guidance in each agent instructions', async () => {
    for (const key of AGENT_KEYS) {
      const agent = mastra.getAgent(key);
      const instructions = await agent.getInstructions({
        requestContext: undefined as never,
      });
      expect(
        String(instructions).includes('Do not create task lists for trivial'),
        key,
      ).toBe(true);
    }
  });

  it('backfills the threadState storage domain the task tools depend on', async () => {
    // The task tools resolve their store through
    // mastra.getStorage().getStore('threadState'); without the composition
    // root's in-memory backfill, @mastra/pg 1.15.0 leaves that domain
    // undefined and every task tool call returns the misleading
    // "requires agent memory" error.
    const storage = await mastra.getStorage();
    expect(storage).toBeDefined();
    const threadState = await storage!.getStore('threadState');
    expect(threadState).toBeDefined();
    expect(typeof threadState?.getState).toBe('function');
    expect(typeof threadState?.setState).toBe('function');
  });

  it('wires the task nudge processor before the char-budget guard', async () => {
    // Spawn reliability: the advisory nudge closes the gap where the model
    // skips task tracking on genuinely multi-step turns. It must run on
    // every code-defined agent, with the char-budget guard still LAST.
    for (const key of AGENT_KEYS) {
      const agent = mastra.getAgent(key);
      const ids = (
        await agent.listConfiguredInputProcessors()
      ).map((p) => (p as { id?: unknown })?.id);
      const nudgeIndex = ids.indexOf('task-nudge');
      const guardIndex = ids.indexOf('char-budget-guard');
      expect(nudgeIndex, key).toBeGreaterThan(-1);
      expect(guardIndex, key).toBeGreaterThan(-1);
      expect(guardIndex, key).toBeGreaterThan(nudgeIndex);
    }
  });
});
