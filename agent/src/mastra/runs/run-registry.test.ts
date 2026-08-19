import { describe, expect, it } from 'vitest';
import {
  RUN_CAPACITY_GLOBAL_MESSAGE,
  RUN_CAPACITY_PER_RESOURCE_MESSAGE,
  RUN_MAX_DURATION_MESSAGE,
  RunCapacityError,
  RunConflictError,
  RunRegistry,
  createRunId,
  isRunId,
} from './run-registry.js';

function fixedClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: () => (current += 1_000),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeRegistry(overrides: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}) {
  const clock = fixedClock();
  return {
    clock,
    registry: new RunRegistry({ now: clock.now, ...overrides }),
  };
}

const TUPLE = {
  agentId: 'main-agent',
  threadId: 'main-agent-user-1-uuid-a',
  resourceId: 'user-1',
  prompt: 'do a thing',
};

describe('createRunId', () => {
  it('produces ids matching the canonical pattern', () => {
    const id = createRunId();
    expect(isRunId(id)).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(isRunId('run_1_ab')).toBe(false);
    expect(isRunId('pmr_20260101000000_deadbeef')).toBe(false);
    expect(isRunId('')).toBe(false);
  });
});

function startRun(
  registry: RunRegistry,
  overrides: Partial<{ agentId: string; threadId: string; resourceId: string }> = {},
  requestAbort: () => void = () => undefined,
) {
  return registry.createRun({
    id: createRunId(),
    agentId: overrides.agentId ?? TUPLE.agentId,
    threadId: overrides.threadId ?? TUPLE.threadId,
    resourceId: overrides.resourceId ?? TUPLE.resourceId,
    prompt: TUPLE.prompt,
    requestAbort,
  });
}

describe('RunRegistry concurrency caps', () => {
  it('rejects the 5th concurrent running run for one resource with 4', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 4; i++) {
      startRun(registry, { threadId: `main-agent-user-1-uuid-${i}` });
    }

    expect(() => startRun(registry, { threadId: 'main-agent-user-1-uuid-x' }))
      .toThrowError(RunCapacityError);
    try {
      startRun(registry, { threadId: 'main-agent-user-1-uuid-x' });
    } catch (error) {
      expect((error as RunCapacityError).message).toBe(
        RUN_CAPACITY_PER_RESOURCE_MESSAGE,
      );
    }

    // Registry state stays intact: the four running runs remain and other
    // users are unaffected.
    expect(registry.listActiveRuns('user-1')).toHaveLength(4);
    expect(
      registry.findActiveRun('main-agent', 'main-agent-user-1-uuid-0', 'user-1'),
    ).not.toBeNull();
    expect(() =>
      startRun(registry, {
        resourceId: 'user-2',
        threadId: 'main-agent-user-2-uuid-a',
      }),
    ).not.toThrow();
  });

  it('rejects starts above the global concurrent cap across resources', () => {
    const { registry } = makeRegistry({ maxConcurrentRuns: 3 });
    for (let i = 0; i < 3; i++) {
      startRun(registry, {
        resourceId: `user-${i}`,
        threadId: `main-agent-user-${i}-uuid-a`,
      });
    }

    try {
      startRun(registry, {
        resourceId: 'user-9',
        threadId: 'main-agent-user-9-uuid-a',
      });
      throw new Error('expected RunCapacityError');
    } catch (error) {
      expect(error).toBeInstanceOf(RunCapacityError);
      expect((error as RunCapacityError).message).toBe(
        RUN_CAPACITY_GLOBAL_MESSAGE,
      );
    }
  });

  it('still reports the 409 conflict (not capacity) for a duplicate start', () => {
    const { registry } = makeRegistry({ maxConcurrentRunsPerResource: 1 });
    const first = startRun(registry);

    try {
      startRun(registry);
      throw new Error('expected RunConflictError');
    } catch (error) {
      // The client must receive the active run to attach to, even at cap.
      expect(error).toBeInstanceOf(RunConflictError);
      expect((error as RunConflictError).run.id).toBe(first.id);
    }
  });

  it('does not count terminal runs against the caps', () => {
    const { registry } = makeRegistry({ maxConcurrentRunsPerResource: 2 });
    const first = startRun(registry, { threadId: 'main-agent-user-1-uuid-0' });
    startRun(registry, { threadId: 'main-agent-user-1-uuid-1' });
    registry.finishRun(first.id, 'completed');

    expect(() =>
      startRun(registry, { threadId: 'main-agent-user-1-uuid-2' }),
    ).not.toThrow();
  });
});

describe('RunRegistry max-duration watchdog', () => {
  it('force-fails over-duration running runs and releases the thread lock', () => {
    const { registry, clock } = makeRegistry({ maxRunDurationMs: 60_000 });
    const aborted: string[] = [];
    const run = startRun(
      registry,
      { threadId: 'main-agent-user-1-uuid-w' },
      () => aborted.push(run.id),
    );

    // The injected clock ticks on every now() read; keep comfortable
    // margins on both sides of the 60s cap.
    clock.advance(50_000);
    registry.getRun(run.id);
    expect(registry.getRun(run.id)?.status).toBe('running');

    clock.advance(20_000); // past the 60s duration cap
    const final = registry.getRun(run.id);

    expect(final?.status).toBe('failed');
    expect(final?.error).toBe(RUN_MAX_DURATION_MESSAGE);
    expect(aborted).toEqual([run.id]);
    // The thread's active-run 409 lock is released: a new run can start.
    expect(
      registry.findActiveRun('main-agent', 'main-agent-user-1-uuid-w', 'user-1'),
    ).toBeNull();
    expect(() =>
      startRun(registry, { threadId: 'main-agent-user-1-uuid-w' }),
    ).not.toThrow();
  });

  it('appends the terminal error event so subscribers and replay see the failure', () => {
    const { registry, clock } = makeRegistry({ maxRunDurationMs: 1_000 });
    const run = startRun(registry);

    clock.advance(2_000);
    const seen: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => seen.push(event.type));

    expect(seen).toEqual(['error']);
  });

  it('a late execution finalize after the watchdog is a no-op', () => {
    const { registry, clock } = makeRegistry({ maxRunDurationMs: 1_000 });
    const run = startRun(registry);

    clock.advance(2_000);
    // Any run API touch performs the reap; the execution loop waking up
    // afterwards must not overwrite the watchdog's terminal state.
    registry.getRun(run.id);
    const late = registry.finishRun(run.id, 'completed');

    expect(late?.status).toBe('failed');
    expect(late?.error).toBe(RUN_MAX_DURATION_MESSAGE);
  });

  it('leaves runs within the duration untouched', () => {
    const { registry, clock } = makeRegistry({ maxRunDurationMs: 60_000 });
    const run = startRun(registry);

    clock.advance(30_000);
    registry.listActiveRuns('user-1');
    expect(registry.getRun(run.id)?.status).toBe('running');
  });
});

describe('RunRegistry lifecycle', () => {
  it('creates a run in the running state', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    expect(run.status).toBe('running');
    expect(run.agentId).toBe(TUPLE.agentId);
    expect(run.prompt).toBe(TUPLE.prompt);
    expect(registry.getRun(run.id)?.status).toBe('running');
  });

  it('allows at most one non-terminal run per agent/thread/resource', () => {
    const { registry } = makeRegistry();
    const first = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    expect(() =>
      registry.createRun({
        id: createRunId(),
        ...TUPLE,
        requestAbort: () => undefined,
      }),
    ).toThrowError(RunConflictError);

    try {
      registry.createRun({
        id: createRunId(),
        ...TUPLE,
        requestAbort: () => undefined,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RunConflictError);
      expect((error as RunConflictError).run.id).toBe(first.id);
    }

    registry.finishRun(first.id, 'completed');
    const second = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });
    expect(second.id).not.toBe(first.id);
  });

  it('isolates runs across threads and agents', () => {
    const { registry } = makeRegistry();
    registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    const otherThread = registry.createRun({
      id: createRunId(),
      agentId: 'main-agent',
      threadId: 'main-agent-user-1-uuid-b',
      resourceId: 'user-1',
      prompt: 'other thread prompt',
      requestAbort: () => undefined,
    });
    const otherAgent = registry.createRun({
      id: createRunId(),
      agentId: 'pm-agent',
      threadId: 'pm-agent-user-1-uuid-a',
      resourceId: 'user-1',
      prompt: 'other agent prompt',
      requestAbort: () => undefined,
    });

    expect(otherThread.status).toBe('running');
    expect(otherAgent.status).toBe('running');
    expect(registry.listActiveRuns('user-1')).toHaveLength(3);
  });

  it('rejects malformed run ids', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.createRun({
        id: 'not-a-run-id',
        ...TUPLE,
        requestAbort: () => undefined,
      }),
    ).toThrowError(/Invalid run id/);
  });
});

describe('RunRegistry discovery', () => {
  it('finds the active run for a thread and hides terminal runs', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    expect(registry.findActiveRun(TUPLE.agentId, TUPLE.threadId, TUPLE.resourceId)?.id).toBe(run.id);
    registry.finishRun(run.id, 'completed');
    expect(registry.findActiveRun(TUPLE.agentId, TUPLE.threadId, TUPLE.resourceId)).toBeNull();
  });

  it('never returns another resource or agent run', () => {
    const { registry } = makeRegistry();
    registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    expect(
      registry.findActiveRun('main-agent', 'main-agent-user-2-uuid-a', 'user-2'),
    ).toBeNull();
    expect(registry.listActiveRuns('user-2')).toEqual([]);
  });

  it('scopes the list by optional agentId', () => {
    const { registry } = makeRegistry();
    registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });
    registry.createRun({
      id: createRunId(),
      agentId: 'pm-agent',
      threadId: 'pm-agent-user-1-uuid-a',
      resourceId: 'user-1',
      prompt: 'pm prompt',
      requestAbort: () => undefined,
    });

    expect(registry.listActiveRuns('user-1')).toHaveLength(2);
    expect(registry.listActiveRuns('user-1', 'pm-agent')).toHaveLength(1);
  });
});

describe('RunRegistry events', () => {
  it('appends sequential events and replays them from an offset', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    registry.appendEvent(run.id, 'text-delta', { text: 'Hello' });
    registry.appendEvent(run.id, 'text-delta', { text: ' world' });
    registry.appendEvent(run.id, 'tool-call', {
      toolCallId: 'tc-1',
      toolName: 'search',
    });

    const all: number[] = [];
    registry.subscribeFrom(run.id, 0, (event) => all.push(event.sequence));
    expect(all).toEqual([0, 1, 2]);

    const tail: number[] = [];
    registry.subscribeFrom(run.id, 2, (event) => tail.push(event.sequence));
    expect(tail).toEqual([2]);
  });

  it('streams live events to subscribers after replay', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    const received: string[] = [];
    const { unsubscribe } = registry.subscribeFrom(run.id, 0, (event) => {
      if (event.type === 'text-delta') {
        received.push(String(event.payload.text));
      }
    })!;

    registry.appendEvent(run.id, 'text-delta', { text: 'live' });
    unsubscribe();
    registry.appendEvent(run.id, 'text-delta', { text: 'missed' });

    expect(received).toEqual(['live']);
  });

  it('delivers the terminal event exactly once and stops live delivery', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    const seen: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => seen.push(event.type));

    registry.appendEvent(run.id, 'text-delta', { text: 'x' });
    registry.finishRun(run.id, 'completed');

    expect(seen).toEqual(['text-delta', 'finish']);
  });

  it('ignores appends to unknown or terminal runs', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });
    registry.finishRun(run.id, 'failed', 'boom');

    expect(registry.appendEvent(run.id, 'text-delta', { text: 'late' })).toBeNull();
    expect(registry.appendEvent('run_00000000000000_00000000', 'text-delta', {})).toBeNull();
  });

  it('evicts oldest events when the buffer cap is exceeded and flags the run', () => {
    const { registry } = makeRegistry({
      maxEventsPerRun: 5,
    });
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    for (let i = 0; i < 12; i++) {
      registry.appendEvent(run.id, 'text-delta', { text: `chunk-${i}` });
    }

    const sequences: number[] = [];
    registry.subscribeFrom(run.id, 0, (event) => sequences.push(event.sequence));
    expect(sequences.length).toBeLessThan(12);
    expect(sequences[0]).toBeGreaterThan(0);
    expect(registry.getRun(run.id)?.evicted).toBe(true);

    // Replay from an offset below the eviction point still works.
    const tail: number[] = [];
    registry.subscribeFrom(run.id, 3, (event) => tail.push(event.sequence));
    expect(tail[0]).toBe(sequences[0]);
  });

  it('returns null when subscribing to an unknown run', () => {
    const { registry } = makeRegistry();
    expect(
      registry.subscribeFrom('run_00000000000000_00000000', 0, () => undefined),
    ).toBeNull();
  });
});

describe('RunRegistry cancellation', () => {
  it('aborts exactly the target run and is idempotent', () => {
    const { registry } = makeRegistry();
    const aborted: string[] = [];

    const runA = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => aborted.push('a'),
    });
    const runB = registry.createRun({
      id: createRunId(),
      agentId: 'main-agent',
      threadId: 'main-agent-user-1-uuid-b',
      resourceId: 'user-1',
      prompt: 'run b prompt',
      requestAbort: () => aborted.push('b'),
    });

    const cancelled = registry.requestCancel(runA.id);
    expect(cancelled?.status).toBe('running'); // finalized by the execution loop
    expect(aborted).toEqual(['a']);

    registry.requestCancel(runA.id);
    expect(aborted).toEqual(['a']);

    registry.finishRun(runA.id, 'cancelled');
    expect(registry.requestCancel(runA.id)?.status).toBe('cancelled');
    expect(runB.status).toBe('running');
  });

  it('returns null for unknown run ids', () => {
    const { registry } = makeRegistry();
    expect(registry.requestCancel('run_00000000000000_00000000')).toBeNull();
  });
});

describe('RunRegistry terminal retention', () => {
  it('keeps terminal runs discoverable until the TTL expires', () => {
    const { registry, clock } = makeRegistry({ terminalTtlMs: 60_000 });
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });
    registry.finishRun(run.id, 'completed');

    expect(registry.getRun(run.id)?.status).toBe('completed');

    clock.advance(120_000);
    expect(registry.getRun(run.id)).toBeNull();
  });

  it('evicts the oldest terminal runs when the registry overflows', () => {
    const { registry } = makeRegistry({ maxRuns: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        requestAbort: () => undefined,
      });
      registry.finishRun(run.id, 'completed');
      ids.push(run.id);
    }

    const survivor = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    expect(registry.getRun(ids[0])).toBeNull();
    expect(registry.getRun(ids[1])?.id).toBe(ids[1]);
    expect(registry.getRun(ids[2])?.id).toBe(ids[2]);
    expect(registry.getRun(survivor.id)?.status).toBe('running');
  });

  it('first finishRun wins over racing finalize paths', () => {
    const { registry } = makeRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      requestAbort: () => undefined,
    });

    registry.finishRun(run.id, 'completed');
    const second = registry.finishRun(run.id, 'failed', 'late error');

    expect(second?.status).toBe('completed');
    expect(second?.error).toBeUndefined();
  });
});
