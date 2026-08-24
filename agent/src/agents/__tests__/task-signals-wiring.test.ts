import { describe, expect, it } from 'vitest';
import { mastra } from '../../mastra/index.js';
import { BoundedThreadStateStorage } from '../../mastra/tasks/task-state-store.js';
import {
  createdTaskSignalProviders,
  TASK_TOOL_NAMES,
} from '../../mastra/tasks/task-signals.js';
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

  it('bounds task tool input at the Chekku boundary', async () => {
    // Core's task tool schemas are unbounded (`z.string().min(1)`, no
    // array cap); the Chekku-wrapped schemas must reject oversized lists,
    // field text, and ids before the arguments reach the thread store.
    const tools = createdTaskSignalProviders()[0]!.getTools() as Record<
      string,
      { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    >;
    const flood = Array.from({ length: 101 }, (_, i) => ({
      content: `Task ${i}`,
      status: 'pending',
      activeForm: `Working on task ${i}`,
    }));
    expect(
      tools.task_write!.inputSchema.safeParse({ tasks: flood }).success,
    ).toBe(false);
    expect(
      tools.task_write.inputSchema.safeParse({
        tasks: [
          { content: 'x'.repeat(501), status: 'pending', activeForm: 'ok' },
        ],
      }).success,
    ).toBe(false);
    expect(
      tools.task_update.inputSchema.safeParse({ id: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('uses a bounded, evicting threadState store wired to thread deletion', async () => {
    const storage = await mastra.getStorage();
    expect(storage).toBeDefined();
    const threadState = await storage!.getStore('threadState');
    expect(threadState).toBeInstanceOf(BoundedThreadStateStorage);

    // Deleting a memory thread must drop its task state instead of
    // leaking it for the process lifetime.
    const threadId = 'main-agent-local-user-eviction-test';
    await threadState!.setState({ threadId, type: 'task', value: [] });
    const memory = await storage!.getStore('memory');
    await memory!.deleteThread({ threadId });
    expect(
      await threadState!.getState({ threadId, type: 'task' }),
    ).toBeUndefined();
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

  it('gives every agent task-state processor a live mastra reference', async () => {
    // `Mastra#addProcessor` dedupes by processor id and skips
    // `__registerMastra` for duplicates. Every agent's TaskSignalProvider
    // builds its own `TaskStateProcessor` with the hardcoded id
    // "task-state", so without unique-key registration only the first
    // agent's processor would resolve the thread-state store; the other
    // seven would silently fall back to reconstructing tasks from
    // in-window messages and lose the list once it scrolls out of
    // `lastMessages`.
    const providers = createdTaskSignalProviders();
    expect(providers.length).toBeGreaterThanOrEqual(AGENT_KEYS.length);
    for (const [index, provider] of providers.entries()) {
      const processor = provider.getInputProcessors()[0] as unknown as {
        id?: unknown;
        resolveTaskStore?: () => Promise<unknown>;
      };
      expect(processor?.id, `provider ${index}`).toBe('task-state');
      await expect(
        processor?.resolveTaskStore?.(),
        `provider ${index} resolveTaskStore`,
      ).resolves.toBeDefined();
    }
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
