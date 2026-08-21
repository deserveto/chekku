import { TaskSignalProvider } from '@mastra/core/signals';

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
 * Fresh signal list per agent. `SignalProvider.connect()` binds a provider
 * to one agent instance, so providers must never be shared across agents;
 * calling this factory per agent config keeps every agent isolated.
 */
export function createTaskSignals(): TaskSignalProvider[] {
  return [new TaskSignalProvider()];
}
