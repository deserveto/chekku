import type { Mastra } from '@mastra/core/mastra';
import { TaskSignalProvider } from '@mastra/core/signals';
import { BoundedTaskSignalProvider } from './bounded-task-tools.js';

/**
 * Shared task-tracking wiring for Chekku agents.
 *
 * Mastra's native Task Lists surface through `TaskSignalProvider`, which
 * bundles the four task tools (`task_write`, `task_update`, `task_complete`,
 * `task_check`) and the `TaskStateProcessor` that keeps the list alive in the
 * thread-scoped task store across turns. Task tracking requires a
 * memory-backed thread; agents without memory get no-op tools that report
 * that requirement.
 */

/** The tool names TaskSignalProvider registers on an agent. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task_write',
  'task_update',
  'task_complete',
  'task_check',
]);

/**
 * Instructions guidance appended to every task-capable agent so agents share
 * one policy: track meaningful multi-step work, never trivial requests.
 */
export const TASK_GUIDANCE = `

Task tracking:
- Use the task tools to track meaningful multi-step or long-running work (complex research, multiple tool calls, QA workflows, multi-stage deliverables).
- Create the task list before starting substantial multi-step execution; keep no more than one task in_progress at a time.
- Update tasks as the plan changes and mark them completed immediately after finishing them; check for incomplete tasks before giving your final response.
- Do not create task lists for trivial questions or simple single-step requests.`;

/**
 * Every provider created by this module, in creation order. Mastra's
 * processor registry dedupes by processor id, so agents need help getting
 * their task-state processors properly registered (see
 * `registerTaskSignalProcessors`); this list is the composition root's and
 * the wiring tests' view of those providers.
 */
const createdProviders: TaskSignalProvider[] = [];

/**
 * Fresh signal list per agent. `SignalProvider.connect()` binds a provider
 * to one agent instance, so providers must never be shared across agents;
 * calling this factory per agent config keeps every agent isolated.
 */
export function createTaskSignals(): TaskSignalProvider[] {
  const providers: TaskSignalProvider[] = [new BoundedTaskSignalProvider()];
  createdProviders.push(...providers);
  return providers;
}

/** Providers created so far, oldest first (wiring-test introspection). */
export function createdTaskSignalProviders(): readonly TaskSignalProvider[] {
  return Object.freeze([...createdProviders]);
}

/**
 * Register every created provider's input processors under unique keys.
 *
 * `Mastra#addProcessor(processor)` dedupes on `processor.id` and returns
 * before calling `processor.__registerMastra` for duplicates. Every
 * `TaskSignalProvider` constructs its own `TaskStateProcessor` with the
 * hardcoded id `"task-state"`, so when the eight code-defined agents
 * register through the default path only the first one's processor ever
 * receives its `mastra` reference — the rest silently lose durable task
 * state (`resolveTaskStore()` returns undefined) and fall back to
 * reconstructing tasks from in-window `<current-task-list>` messages.
 * Re-registering each processor under a unique key runs
 * `__registerMastra` for all of them; the duplicate default-key entry for
 * the first agent is harmless (same instance, never looked up).
 */
export function registerTaskSignalProcessors(mastra: Mastra): void {
  createdProviders.forEach((provider, providerIndex) => {
    provider.getInputProcessors().forEach((processor, processorIndex) => {
      mastra.addProcessor(
        processor,
        `${provider.id}:${providerIndex}:${processorIndex}`,
      );
    });
  });
}
