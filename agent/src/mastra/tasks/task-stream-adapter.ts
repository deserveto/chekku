import { TASK_TOOL_NAMES } from './task-signals.js';

/**
 * Isolated adapter that understands how the installed @mastra/core surfaces
 * task state in the agent stream and normalizes it into Chekku's run-event
 * model. This is the ONLY module allowed to know Mastra's task chunk shape;
 * upstream task signals are experimental and may change, so every other
 * layer consumes the normalized snapshot instead.
 *
 * In the installed version the authoritative snapshot rides the `tool-result`
 * chunks of the four task tools: every successful result carries
 * `{ content, tasks: [...], isError: false }` with the full current list.
 */

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

export type TaskItem = {
  id: string;
  content: string;
  activeForm: string;
  status: TaskItemStatus;
};

export type TaskStreamChunk = {
  type?: unknown;
  payload?: unknown;
};

/** Defensive caps so a runaway task list cannot flood the run event buffer. */
const MAX_TASKS = 100;
const MAX_TASK_TEXT_CHARS = 500;

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

/**
 * Normalize one raw task entry. Returns null for entries that lack the
 * fields the UI needs; invalid entries are skipped, never fatal.
 */
function normalizeTask(value: unknown): TaskItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;

  const content = clampText(record.content);
  if (!content) return null;

  const status =
    typeof record.status === 'string' && TASK_STATUSES.has(record.status)
      ? (record.status as TaskItemStatus)
      : null;
  if (!status) return null;

  const activeForm = clampText(record.activeForm) ?? content;

  return { id, content, activeForm, status };
}

/**
 * Extract a normalized task snapshot from a Mastra stream chunk.
 *
 * Returns null when the chunk is not a successful task-tool result carrying
 * a usable `tasks` array (unknown chunk types, tool errors, malformed
 * payloads) — callers treat null as "nothing to publish" and execution
 * continues unaffected.
 */
export function extractTaskSnapshot(chunk: TaskStreamChunk): TaskItem[] | null {
  if (chunk.type !== 'tool-result') return null;

  const payload =
    chunk.payload && typeof chunk.payload === 'object'
      ? (chunk.payload as Record<string, unknown>)
      : null;
  if (!payload) return null;

  const toolName = payload.toolName;
  if (typeof toolName !== 'string' || !TASK_TOOL_NAMES.has(toolName)) {
    return null;
  }
  if (payload.isError === true) return null;

  const result = payload.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  // The task tools report semantic failures (no memory, validation) inside
  // their output object instead of throwing; those carry no snapshot.
  if ((result as Record<string, unknown>).isError === true) return null;

  const rawTasks = (result as Record<string, unknown>).tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return null;

  const tasks: TaskItem[] = [];
  for (const entry of rawTasks) {
    const task = normalizeTask(entry);
    if (task) tasks.push(task);
    if (tasks.length >= MAX_TASKS) break;
  }

  return tasks.length > 0 ? tasks : null;
}
