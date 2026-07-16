import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

export const dailyTaskOutputSchema = z.object({
  ok: z.boolean(),
  firedAt: z.string(),
  message: z.string(),
});
export type DailyTaskOutput = z.infer<typeof dailyTaskOutputSchema>;

/**
 * Pure builder for the daily-tick payload. Kept separate from the step so tests
 * can verify the shape deterministically without constructing a full
 * step-execution context. `now` is injectable; production passes nothing and
 * uses the current time.
 */
export function dailyTickResult(now: Date = new Date()): DailyTaskOutput {
  const firedAt = now.toISOString();
  return { ok: true, firedAt, message: `daily tick at ${firedAt}` };
}

const dailyTick = createStep({
  id: "daily-tick",
  inputSchema: z.object({}),
  outputSchema: dailyTaskOutputSchema,
  execute: async () => dailyTickResult(),
});

/**
 * Daily scheduled workflow (placeholder). Fires every day at 09:00
 * Asia/Jakarta via Mastra's built-in scheduler, which runs on the long-lived
 * `mastra` host process (see `agent/src/mastra/index.ts`). The scheduler reads
 * the `schedule` field on boot — no separate registration call.
 *
 * The step is an intentionally trivial heartbeat that proves the scheduler
 * fires. Swap `dailyTickResult` / the step body when wiring this to a real
 * task (e.g. an agent-generated report). Scheduled fires and manual
 * `workflow.start()` share the same execution path.
 */
export const dailyTask = createWorkflow({
  id: "daily-task",
  inputSchema: z.object({}),
  outputSchema: dailyTaskOutputSchema,
  schedule: { cron: "0 9 * * *", timezone: "Asia/Jakarta", inputData: {} },
})
  .then(dailyTick)
  .commit();
