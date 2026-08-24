import { createTool } from '@mastra/core/tools';
import { TaskSignalProvider } from '@mastra/core/signals';
import { z } from 'zod';

/**
 * Chekku boundary around Mastra's native task tools.
 *
 * Core's task tool schemas are unbounded (`z.string().min(1)` fields, no
 * array cap) and task content is model-authored — an externally
 * influenced growth path in the long-lived agent server. The wrappers
 * below narrow the input schemas before the model's arguments reach the
 * thread-state store; execution delegates unchanged to the core tools
 * (memory checks, id assignment, and result shaping stay upstream).
 */

export const MAX_TASKS_PER_LIST = 100;
export const MAX_TASK_TEXT_CHARS = 500;
export const MAX_TASK_ID_CHARS = 128;

const boundText = (description: string) =>
  z.string().min(1).max(MAX_TASK_TEXT_CHARS).describe(description);

const taskId = z
  .string()
  .min(1)
  .max(MAX_TASK_ID_CHARS)
  .describe(
    'Stable task identifier (for example, "task_investigate_tests"). Keep this unchanged across updates.',
  );

const taskItemInput = z.object({
  id: taskId.optional(),
  content: boundText('Task description in imperative form (e.g., "Fix authentication bug")'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('Current task status'),
  activeForm: boundText(
    'Present continuous form shown during execution (e.g., "Fixing authentication bug")',
  ),
});

const taskWriteInput = z.object({
  tasks: z
    .array(taskItemInput)
    .max(MAX_TASKS_PER_LIST)
    .describe(`The complete updated task list (at most ${MAX_TASKS_PER_LIST} tasks)`),
});

const taskUpdateInput = z
  .object({
    id: taskId,
    content: boundText('New task description in imperative form').optional(),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .optional()
      .describe('New task status'),
    activeForm: boundText('New present continuous form shown during execution').optional(),
  })
  .refine(
    (input) =>
      input.content !== undefined ||
      input.status !== undefined ||
      input.activeForm !== undefined,
    { message: 'Provide at least one field to update.' },
  );

const taskCompleteInput = z.object({ id: taskId });

/** The tool-record shape the provider's `getTools()` returns. */
type ProviderToolBag = ReturnType<TaskSignalProvider['getTools']>;
type ProviderTool = NonNullable<ProviderToolBag['task_write']>;

function wrapTool(
  name: string,
  base: ProviderTool,
  inputSchema: z.ZodTypeAny,
): ProviderTool {
  const execute = base.execute?.bind(base);
  return createTool({
    id: name,
    description: base.description,
    inputSchema,
    execute: (input, context) => execute?.(input, context),
  }) as ProviderTool;
}

/**
 * Replace the four raw core task tools with schema-bounded wrappers that
 * delegate execution unchanged. Unknown tools pass through untouched.
 */
export function boundTaskTools<T extends Partial<ProviderToolBag>>(base: T): T {
  return {
    ...base,
    ...(base.task_write
      ? { task_write: wrapTool('task_write', base.task_write, taskWriteInput) }
      : {}),
    ...(base.task_update
      ? {
          task_update: wrapTool('task_update', base.task_update, taskUpdateInput),
        }
      : {}),
    ...(base.task_complete
      ? {
          task_complete: wrapTool(
            'task_complete',
            base.task_complete,
            taskCompleteInput,
          ),
        }
      : {}),
  } as T;
}

/**
 * TaskSignalProvider whose task tools carry Chekku's input bounds. Tool
 * registration, the state processor, and per-agent binding are inherited
 * from the core provider untouched.
 */
export class BoundedTaskSignalProvider extends TaskSignalProvider {
  override getTools(): ProviderToolBag {
    return boundTaskTools(super.getTools());
  }
}
