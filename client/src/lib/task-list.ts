import type { AssistantPart } from './types';

/**
 * Client model for agent task lists (Mastra native Task Lists surfaced as
 * `task-list` run events). Canonical task state lives on the agent server
 * (Mastra thread task store + run event snapshots); the client only keeps
 * the latest snapshot for the thread it is viewing. Panel open/collapsed is
 * a separate UI preference and is never a task data source.
 */

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

export type TaskItem = {
  id: string;
  content: string;
  activeForm: string;
  status: TaskItemStatus;
};

export type ThreadTaskState = {
  tasks: TaskItem[];
  updatedAt?: string;
};

/** The Mastra task tool names whose cards are suppressed from the timeline. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task_write',
  'task_update',
  'task_complete',
  'task_check',
]);

export function isTaskToolName(name: string | undefined): boolean {
  return typeof name === 'string' && TASK_TOOL_NAMES.has(name);
}

const MAX_TASKS = 100;
const MAX_TASK_TEXT_CHARS = 500;
/** Ids beyond this are dropped, not clamped: a truncated id breaks
 *  task_update/task_complete targeting. */
const MAX_TASK_ID_CHARS = 128;
const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
]);

function clampText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const characters = Array.from(trimmed);
  if (characters.length <= MAX_TASK_TEXT_CHARS) return trimmed;
  return `${characters.slice(0, MAX_TASK_TEXT_CHARS - 1).join('').trimEnd()}…`;
}

function normalizeTask(value: unknown): TaskItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id || id.length > MAX_TASK_ID_CHARS) return null;

  const content = clampText(record.content);
  if (!content) return null;

  const status =
    typeof record.status === 'string' && TASK_STATUSES.has(record.status)
      ? (record.status as TaskItemStatus)
      : null;
  if (!status) return null;

  return { id, content, activeForm: clampText(record.activeForm) ?? content, status };
}

/**
 * Parse the payload of a `task-list` run event. Returns null for malformed
 * snapshots — callers ignore them so a bad event never breaks the run view.
 */
export function parseTaskListPayload(payload: unknown): TaskItem[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawTasks = (payload as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks)) return null;
  // An empty array is a first-class "cleared" snapshot: dropping it kept
  // the pre-clearing state on the dock and resurrected the deleted list
  // after reload. Non-empty-but-all-invalid stays malformed (null).
  if (rawTasks.length === 0) return [];

  const tasks: TaskItem[] = [];
  for (const entry of rawTasks) {
    const task = normalizeTask(entry);
    if (task) tasks.push(task);
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks.length > 0 ? tasks : null;
}

/**
 * Apply a snapshot to thread task state. Snapshots are authoritative and
 * replace the previous list (never merge), so replaying several snapshots
 * deterministically resolves to the latest one and never duplicates rows.
 */
export function applyTaskSnapshot(
  state: ThreadTaskState | null,
  tasks: TaskItem[],
  updatedAt?: string,
): ThreadTaskState {
  return { tasks, ...(updatedAt ? { updatedAt } : {}) };
}

export function taskProgress(
  tasks: TaskItem[],
): { completed: number; total: number } {
  return {
    completed: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
  };
}

/**
 * Recover the latest task snapshot from a restored Memory thread. Mastra
 * persists the task tool calls as assistant message parts; every successful
 * task tool result carries the full list, so scanning in order and keeping
 * the last valid snapshot reconstructs historical task state without the
 * run registry. Task tool parts are skipped by `restoreAssistantParts`, so
 * this reads the same persisted data before that filtering happens.
 */
export function tasksFromRestoredParts(
  parts: AssistantPart[] | undefined,
): TaskItem[] | null {
  if (!parts || parts.length === 0) return null;

  let latest: TaskItem[] | null = null;
  for (const part of parts) {
    if (part.type !== 'tool' || !isTaskToolName(part.toolName)) continue;
    if (part.status === 'error') continue;
    // Core's task tools report semantic failures (validation, missing
    // memory) inside a *successful* result object — `{ content: 'Failed
    // to update tasks: …', tasks: [], isError: true }`. That empty list
    // is not a snapshot: honoring it would wipe the dock after reload
    // for a transient failure (mirrors the server adapter's rule).
    const result = part.result;
    if (
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (result as Record<string, unknown>).isError === true
    ) {
      continue;
    }
    const snapshot = parseTaskListPayload(result);
    if (snapshot) latest = snapshot;
  }
  return latest;
}

/**
 * Extract task tool results for timeline suppression checks: given restored
 * parts, return the tool parts that are NOT task tools (task tools are an
 * implementation detail of the Tasks dock and never render as cards).
 */
export function withoutTaskToolParts(
  parts: AssistantPart[],
): AssistantPart[] {
  return parts.filter(
    (part) => !(part.type === 'tool' && isTaskToolName(part.toolName)),
  );
}
