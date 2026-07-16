import { describe, it, expect } from 'vitest';

import {
  dailyTask,
  dailyTickResult,
  dailyTaskOutputSchema,
} from '../daily-task.js';

describe('dailyTickResult', () => {
  it('builds an ok payload with a deterministic ISO timestamp', () => {
    // 09:00 +07:00 is 02:00 UTC.
    const result = dailyTickResult(new Date('2026-07-16T09:00:00+07:00'));
    expect(result).toEqual({
      ok: true,
      firedAt: '2026-07-16T02:00:00.000Z',
      message: 'daily tick at 2026-07-16T02:00:00.000Z',
    });
  });

  it('defaults to the current time when no date is given', () => {
    const result = dailyTickResult();
    expect(result.ok).toBe(true);
    expect(new Date(result.firedAt).toISOString()).toBe(result.firedAt);
    expect(result.message).toContain('daily tick at');
  });

  it('satisfies the workflow output schema', () => {
    const result = dailyTickResult();
    expect(dailyTaskOutputSchema.safeParse(result).success).toBe(true);
  });
});

describe('dailyTask workflow', () => {
  it('has id daily-task', () => {
    expect(dailyTask.id).toBe('daily-task');
  });

  it('constructs with a valid daily schedule (cron is validated at build time)', () => {
    // Reaching this assertion means the `schedule` field on createWorkflow did
    // not throw — the cron expression is well-formed and the workflow is
    // ready for the scheduler to pick up on boot.
    expect(dailyTask).toBeDefined();
  });
});
