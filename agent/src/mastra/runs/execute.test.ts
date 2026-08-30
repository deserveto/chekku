import { describe, expect, it } from 'vitest';
import { RunRegistry, createRunId } from './run-registry.js';
import {
  chunkToRunEvent,
  ensureFirstTurnThread,
  runExecution,
  type MemoryAccess,
  type RunnableAgent,
} from './execute.js';

type Chunk = { type?: unknown; payload?: unknown };

function streamOf(chunks: Chunk[]): { fullStream: ReadableStream<Chunk> } {
  return {
    fullStream: new ReadableStream<Chunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function makeMemory(existing: boolean) {
  const calls: { created: number; titles: Array<string | undefined> } = {
    created: 0,
    titles: [],
  };
  const memory: MemoryAccess = {
    getThreadById: async () => (existing ? { metadata: { kept: true } } : null),
    createThread: async (params) => {
      calls.created += 1;
      calls.titles.push((params as { title?: string }).title);
      return params;
    },
  };
  return { memory, calls };
}

function makeAgent(chunks: Chunk[], memory?: MemoryAccess) {
  const calls: {
    prompt?: Parameters<RunnableAgent['stream']>[0];
    runId?: string;
    threadId?: string;
    resourceId?: string;
    aborted?: AbortSignal;
  } = {};
  const agent: RunnableAgent = {
    stream: async (prompt, options) => {
      calls.prompt = prompt;
      calls.runId = options.runId;
      calls.threadId = options.memory.thread;
      calls.resourceId = options.memory.resource;
      calls.aborted = options.abortSignal;
      if (options.abortSignal.aborted) {
        throw new Error('This operation was aborted');
      }
      return streamOf(chunks);
    },
    getMemory: async () => memory,
  };
  return { agent, calls };
}

const TUPLE = {
  agentId: 'main-agent',
  threadId: 'main-agent-user-1-uuid-a',
  resourceId: 'user-1',
};

describe('chunkToRunEvent', () => {
  it('maps text, tool, and error chunks', () => {
    expect(
      chunkToRunEvent({ type: 'text-delta', payload: { text: 'hi' } }),
    ).toEqual({ type: 'text-delta', payload: { text: 'hi' } });

    expect(
      chunkToRunEvent({
        type: 'tool-call',
        payload: { toolCallId: 'tc-1', toolName: 'search_web', args: { q: 'x' } },
      }),
    ).toEqual({
      type: 'tool-call',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'search_web',
        args: { q: 'x' },
      },
    });

    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: { toolCallId: 'tc-1', toolName: 'search_web', result: 'ok' },
      }),
    ).toEqual({
      type: 'tool-result',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'search_web',
        result: 'ok',
      },
    });

    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: { toolCallId: 'tc-1', toolName: 'search_web', result: 'bad', isError: true },
      })?.type,
    ).toBe('tool-error');
  });

  it('maps the distinct tool-error chunk type the same way', () => {
    // @mastra/core emits tool failures as their own `tool-error` chunk
    // (ToolErrorPayload), not only as tool-result + isError. Dropping it
    // leaves the client's tool card stuck on "running".
    expect(
      chunkToRunEvent({
        type: 'tool-error',
        payload: {
          toolCallId: 'tc-9',
          toolName: 'search_web',
          args: { q: 'x' },
          error: 'engine exploded',
        },
      }),
    ).toEqual({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-9',
        toolName: 'search_web',
        error: 'engine exploded',
      },
    });

    expect(
      chunkToRunEvent({ type: 'tool-error', payload: {} }),
    ).toBeNull();
  });

  it('sanitizes error chunks and ignores unrelated chunk types', () => {
    expect(
      chunkToRunEvent({ type: 'error', payload: { error: 'model down' } }),
    ).toEqual({ type: 'error', payload: { error: 'model down' } });

    expect(chunkToRunEvent({ type: 'step-start', payload: {} })).toBeNull();
    expect(chunkToRunEvent({ type: 'reasoning', payload: {} })).toBeNull();
    expect(chunkToRunEvent({ payload: { text: 'no type' } })).toBeNull();
    expect(chunkToRunEvent({ type: 'text-delta', payload: {} })).toBeNull();
  });

  it('maps tripwire chunks to a visible assistant error with the reason', () => {
    expect(
      chunkToRunEvent({
        type: 'tripwire',
        payload: {
          reason:
            'TokenLimiterProcessor: No messages fit within the remaining token budget.',
        },
      }),
    ).toEqual({
      type: 'error',
      payload: {
        error:
          'Request stopped by a safety limit. TokenLimiterProcessor: No messages fit within the remaining token budget.',
      },
    });
  });

  it('falls back to a fixed tripwire reason when the payload has none', () => {
    expect(
      chunkToRunEvent({ type: 'tripwire', payload: {} }),
    ).toEqual({
      type: 'error',
      payload: { error: 'Request stopped by a safety limit. The request exceeded a processing limit.' },
    });
    expect(
      chunkToRunEvent({ type: 'tripwire', payload: { reason: '   ' } }),
    ).toEqual({
      type: 'error',
      payload: { error: 'Request stopped by a safety limit. The request exceeded a processing limit.' },
    });
  });

  it('keeps the tripwire prefix and bounds oversized reasons', () => {
    const mapped = chunkToRunEvent({
      type: 'tripwire',
      payload: { reason: 'r'.repeat(1_000) },
    });
    expect(mapped).toEqual({
      type: 'error',
      payload: { error: expect.any(String) },
    });
    const text = (
      mapped as unknown as { payload: { error: string } }
    ).payload.error;
    expect(text.startsWith('Request stopped by a safety limit. ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(
      'Request stopped by a safety limit. '.length + 500,
    );
  });
});

describe('chunkToRunEvent task tools', () => {
  const snapshot = [
    {
      id: 'task_1',
      content: 'First task',
      activeForm: 'Working on the first task',
      status: 'completed',
    },
    {
      id: 'task_2',
      content: 'Second task',
      activeForm: 'Working on the second task',
      status: 'in_progress',
    },
  ];

  it('maps a successful task tool result to a task-list snapshot', () => {
    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_write',
          result: { content: 'ok', tasks: snapshot, isError: false },
        },
      }),
    ).toEqual({ type: 'task-list', payload: { tasks: snapshot } });
  });

  it('suppresses task tool calls; surfaces bounded task tool errors', () => {
    expect(
      chunkToRunEvent({
        type: 'tool-call',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_write',
          args: { tasks: snapshot },
        },
      }),
    ).toBeNull();

    // Task tool failures must not be invisible: the dock stays stale
    // without them. Surface a bounded tool-error event (the client routes
    // it to a dock notice, never a timeline card).
    expect(
      chunkToRunEvent({
        type: 'tool-error',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_update',
          error: `Task not found: ${'x'.repeat(2_000)}`,
        },
      }),
    ).toEqual({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'task_update',
        // Bounded to the same 500-char slice as every other run error.
        error: `Task not found: ${'x'.repeat(484)}`,
      },
    });

    // Semantic failures carried inside the result object (no memory,
    // validation) surface the same bounded error instead of vanishing.
    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_check',
          result: { content: 'failed', tasks: [], isError: true },
        },
      }),
    ).toEqual({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'task_check',
        error: 'failed',
      },
    });

    // Non-string error detail must not stringify to "[object Object]".
    expect(
      chunkToRunEvent({
        type: 'tool-error',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_write',
          error: { weird: true },
        },
      }),
    ).toEqual({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'task_write',
        error: 'Unknown error',
      },
    });
    // A result object with no string content falls back the same way
    // instead of leaking a serialized object.
    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: {
          toolCallId: 'tc-1',
          toolName: 'task_write',
          result: { tasks: [], isError: true, detail: { nested: 1 } },
        },
      }) as unknown as { payload: { error: unknown } },
    ).toEqual({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'task_write',
        error: 'Unknown error',
      },
    });
  });

  it('truncates error text on code points so surrogate pairs stay whole', () => {
    // 499 single-unit chars plus one astral emoji = 500 code points but
    // 501 UTF-16 units. A UTF-16-unit slice at 500 would cut the emoji
    // in half and end the notice in a lone surrogate.
    const mapped = chunkToRunEvent({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-1',
        toolName: 'task_write',
        error: `${'a'.repeat(499)}😀`,
      },
    }) as unknown as { payload: { error: string } };
    expect(mapped.payload.error).toBe(`${'a'.repeat(499)}😀`);
    expect(mapped.payload.error.length).toBe(501);

    const overflow = chunkToRunEvent({
      type: 'tool-error',
      payload: {
        toolCallId: 'tc-2',
        toolName: 'task_write',
        error: '😀'.repeat(600),
      },
    }) as unknown as { payload: { error: string } };
    expect(overflow.payload.error.length).toBe(1000); // 500 code points
  });

  it('keeps non-task tool events unchanged', () => {
    expect(
      chunkToRunEvent({
        type: 'tool-result',
        payload: {
          toolCallId: 'tc-2',
          toolName: 'search_web',
          result: { content: 'ok', tasks: snapshot },
        },
      }),
    ).toEqual({
      type: 'tool-result',
      payload: {
        toolCallId: 'tc-2',
        toolName: 'search_web',
        result: { content: 'ok', tasks: snapshot },
      },
    });
  });
});

describe('ensureFirstTurnThread', () => {
  it('creates the missing thread record untitled so Mastra can generate the LLM title', async () => {
    const { memory, calls } = makeMemory(false);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'research the market',
    });

    expect(calls.created).toBe(1);
    expect(calls.titles).toEqual([undefined]);
  });

  it('leaves an existing thread untouched', async () => {
    const { memory, calls } = makeMemory(true);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'second turn',
    });

    expect(calls.created).toBe(0);
  });

  it('swallows storage failures so the run can still start', async () => {
    const brokenMemory: MemoryAccess = {
      getThreadById: async () => null,
      createThread: async () => {
        throw new Error('storage down');
      },
    };
    const { agent } = makeAgent([], brokenMemory);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'title me',
      }),
    ).resolves.toBeUndefined();
  });

  it('does nothing when the agent has no memory', async () => {
    const { agent } = makeAgent([]);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'title me',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('runExecution', () => {
  it('consumes the stream into registry events and completes the run', async () => {
    const registry = new RunRegistry();
    const { memory, calls: memoryCalls } = makeMemory(true);
    const { agent, calls } = makeAgent(
      [
        { type: 'text-delta', payload: { text: 'Hello' } },
        { type: 'text-delta', payload: { text: ' there' } },
        { type: 'tool-call', payload: { toolCallId: 'tc-1', toolName: 'search_web' } },
        { type: 'tool-result', payload: { toolCallId: 'tc-1', toolName: 'search_web', result: 'ok' } },
        { type: 'step-start', payload: {} },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'do a thing',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'do a thing',
      abortSignal: new AbortController().signal,
    });

    expect(calls.prompt).toBe('do a thing');
    expect(calls.runId).toBe(run.id);
    expect(calls.threadId).toBe(TUPLE.threadId);
    expect(calls.resourceId).toBe(TUPLE.resourceId);

    const events: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => events.push(event.type));
    expect(events).toEqual([
      'text-delta',
      'text-delta',
      'tool-call',
      'tool-result',
      'finish',
    ]);

    expect(registry.getRun(run.id)?.status).toBe('completed');
    // Thread creation is owned by ensureFirstTurnThread at run start, not
    // execution.
    expect(memoryCalls.created).toBe(0);
  });

  it('passes transient multimodal content to the agent stream', async () => {
    const registry = new RunRegistry();
    const { agent, calls } = makeAgent([]);
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'photo.png',
      requestAbort: () => undefined,
    });
    const content = [
      { type: 'text' as const, text: '[Attached image: photo.png]' },
      { type: 'image' as const, image: 'QUJD', mimeType: 'image/png' },
    ];

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'photo.png',
      content,
      abortSignal: new AbortController().signal,
    });

    expect(calls.prompt).toEqual([
      { role: 'user', content },
    ]);
  });

  it('appends task-list snapshots in sequence and replays them', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const tasks = [
      { id: 'task_1', content: 'First', activeForm: 'First', status: 'pending' },
    ];
    const { agent } = makeAgent(
      [
        { type: 'tool-call', payload: { toolCallId: 'tc-1', toolName: 'task_write', args: {} } },
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-1',
            toolName: 'task_write',
            result: { content: 'ok', tasks, isError: false },
          },
        },
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-2',
            toolName: 'task_update',
            result: {
              content: 'ok',
              tasks: [
                { ...tasks[0], status: 'in_progress' },
              ],
              isError: false,
            },
          },
        },
        { type: 'text-delta', payload: { text: 'working' } },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'multi-step work',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'multi-step work',
      abortSignal: new AbortController().signal,
    });

    const events: { sequence: number; type: string; payload?: unknown }[] = [];
    registry.subscribeFrom(run.id, 0, (event) =>
      events.push({
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
      }),
    );
    // Task tool calls are suppressed; only the snapshots enter the buffer,
    // in stream order, and replay resolves to the latest state.
    expect(events.map((event) => `${event.sequence}:${event.type}`)).toEqual([
      '0:task-list',
      '1:task-list',
      '2:text-delta',
      '3:finish',
    ]);
    const snapshots = events.filter((event) => event.type === 'task-list');
    expect(snapshots[1]?.payload).toEqual({
      tasks: [{ ...tasks[0], status: 'in_progress' }],
    });
  });

  it('fails the run when the stream reports an error chunk', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const { agent } = makeAgent(
      [
        { type: 'text-delta', payload: { text: 'partial' } },
        { type: 'error', payload: { error: 'gateway exploded' } },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'boom',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'boom',
      abortSignal: new AbortController().signal,
    });

    const final = registry.getRun(run.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toBe('The agent run reported an error.');
  });

  it('emits tool-error events from distinct tool-error chunks without failing the run', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const { agent } = makeAgent(
      [
        { type: 'tool-call', payload: { toolCallId: 'tc-1', toolName: 'search_web' } },
        { type: 'tool-error', payload: { toolCallId: 'tc-1', toolName: 'search_web', error: 'engine exploded' } },
        { type: 'text-delta', payload: { text: 'recovered' } },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'tool failure',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'tool failure',
      abortSignal: new AbortController().signal,
    });

    const events: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => events.push(event.type));
    expect(events).toEqual(['tool-call', 'tool-error', 'text-delta', 'finish']);
    // A failed tool call does not fail the run itself; the model recovered.
    expect(registry.getRun(run.id)?.status).toBe('completed');
  });

  it('marks the run cancelled when the abort signal already fired', async () => {
    const registry = new RunRegistry();
    const { agent } = makeAgent([]);
    const controller = new AbortController();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'stop me',
      requestAbort: () => controller.abort(),
    });

    registry.requestCancel(run.id);

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'stop me',
      abortSignal: controller.signal,
    });

    expect(registry.getRun(run.id)?.status).toBe('cancelled');
  });

  it('fails the run with a sanitized message when the agent stream throws', async () => {
    const registry = new RunRegistry();
    const failing: RunnableAgent = {
      stream: async () => {
        throw new Error('connection refused to model host');
      },
      getMemory: async () => undefined,
    };
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'x',
      requestAbort: () => undefined,
    });

    await runExecution(registry, failing, {
      runId: run.id,
      ...TUPLE,
      prompt: 'x',
      abortSignal: new AbortController().signal,
    });

    const final = registry.getRun(run.id);
    expect(final?.status).toBe('failed');
    expect(final?.error).toBe('connection refused to model host');
  });
});

describe('runExecution token usage recording', () => {
  function quotaSpy() {
    const calls: Array<{ resourceId: string; tokens: number }> = [];
    const quota = {
      consume: (resourceId: string, tokens: number) => {
        calls.push({ resourceId, tokens });
      },
    };
    return { quota, calls };
  }

  it('consumes step deltas and the finish reconciliation against the quota', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const { agent } = makeAgent(
      [
        { type: 'text-delta', payload: { text: 'hi' } },
        { type: 'step-finish', payload: { totalUsage: { totalTokens: 120 } } },
        { type: 'step-finish', payload: { totalUsage: { totalTokens: 300 } } },
        {
          type: 'finish',
          payload: { output: { usage: { totalTokens: 350 } } },
        },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'spend tokens',
      requestAbort: () => undefined,
    });
    const { quota, calls } = quotaSpy();

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'spend tokens',
      abortSignal: new AbortController().signal,
    }, quota);

    // Deltas 120 + 180 from steps, then the 50-token finish shortfall.
    expect(calls).toEqual([
      { resourceId: TUPLE.resourceId, tokens: 120 },
      { resourceId: TUPLE.resourceId, tokens: 180 },
      { resourceId: TUPLE.resourceId, tokens: 50 },
    ]);
    expect(registry.getRun(run.id)?.status).toBe('completed');
  });

  it('keeps consumption when the stream fails mid-run', async () => {
    const registry = new RunRegistry();
    const failing: RunnableAgent = {
      stream: async () => ({
        fullStream: new ReadableStream<Chunk>({
          async start(controller) {
            controller.enqueue({
              type: 'step-finish',
              payload: { totalUsage: { totalTokens: 90 } },
            });
            // Erroring synchronously would discard the queued chunk
            // (controller.error resets the stream's queue), so yield
            // control first: the loop reads the step-finish, then the
            // next read rejects mid-run.
            await new Promise((resolve) => setTimeout(resolve, 0));
            controller.error(new Error('gateway dropped'));
          },
        }),
      }),
      getMemory: async () => undefined,
    };
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'boom mid-stream',
      requestAbort: () => undefined,
    });
    const { quota, calls } = quotaSpy();

    await runExecution(registry, failing, {
      runId: run.id,
      ...TUPLE,
      prompt: 'boom mid-stream',
      abortSignal: new AbortController().signal,
    }, quota);

    expect(calls).toEqual([
      { resourceId: TUPLE.resourceId, tokens: 90 },
    ]);
    expect(registry.getRun(run.id)?.status).toBe('failed');
  });

  it('runs without a quota consumer and emits no usage events either way', async () => {
    const registry = new RunRegistry();
    const { agent } = makeAgent([
      { type: 'step-finish', payload: { totalUsage: { totalTokens: 10 } } },
      { type: 'finish', payload: { output: { usage: { totalTokens: 10 } } } },
    ]);

    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'no quota',
      requestAbort: () => undefined,
    });

    await expect(
      runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'no quota',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    const events: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => events.push(event.type));
    expect(events).toEqual(['finish']); // usage chunks never become events
  });
});
