import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { MessageList } from '@mastra/core/agent/message-list';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { RunRegistry, createRunId, type AgentRunEvent } from './run-registry.js';
import {
  buildCancelledTurnMessages,
  chunkToRunEvent,
  ensureFirstTurnThread,
  generateFirstTurnTitle,
  persistCancelledTurn,
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
    requestContext?: { get(key: string): unknown };
  } = {};
  const agent: RunnableAgent = {
    stream: async (prompt, options) => {
      calls.prompt = prompt;
      calls.runId = options.runId;
      calls.threadId = options.memory.thread;
      calls.resourceId = options.memory.resource;
      calls.aborted = options.abortSignal;
      calls.requestContext = options.requestContext;
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
  it('creates the missing thread record untitled and reports the first turn', async () => {
    const { memory, calls } = makeMemory(false);
    const { agent } = makeAgent([], memory);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'research the market',
      }),
    ).resolves.toBe(true);

    expect(calls.created).toBe(1);
    expect(calls.titles).toEqual([undefined]);
  });

  it('leaves an existing thread untouched and reports a later turn', async () => {
    const { memory, calls } = makeMemory(true);
    const { agent } = makeAgent([], memory);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'second turn',
      }),
    ).resolves.toBe(false);

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
    ).resolves.toBe(false);
  });

  it('does nothing when the agent has no memory', async () => {
    const { agent } = makeAgent([]);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'title me',
      }),
    ).resolves.toBe(false);
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
  it('passes a server-owned requestContext carrying the authenticated resource id', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const { agent, calls } = makeAgent([], memory);
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'who am I',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'who am I',
      abortSignal: new AbortController().signal,
    });

    expect(calls.requestContext).toBeDefined();
    expect(calls.requestContext?.get(MASTRA_RESOURCE_ID_KEY)).toBe(TUPLE.resourceId);
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

  describe('durable stream cleanup (terminal release)', () => {
    it('calls cleanup once after a completed run', async () => {
      const registry = new RunRegistry();
      const cleanup = vi.fn();
      const agent: RunnableAgent = {
        stream: async () => ({
          fullStream: streamOf([
            { type: 'text-delta', payload: { text: 'ok' } },
          ]).fullStream,
          cleanup,
        }),
        getMemory: async () => undefined,
      };
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'durable done',
        requestAbort: () => undefined,
      });

      await runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'durable done',
        abortSignal: new AbortController().signal,
      });

      expect(registry.getRun(run.id)?.status).toBe('completed');
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('calls cleanup after a cancelled run', async () => {
      const registry = new RunRegistry();
      const cleanup = vi.fn();
      const controller = new AbortController();
      const agent: RunnableAgent = {
        stream: async () => {
          controller.abort();
          return {
            fullStream: streamOf([]).fullStream,
            cleanup,
          };
        },
        getMemory: async () => undefined,
      };
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'durable stop',
        requestAbort: () => controller.abort(),
      });

      registry.requestCancel(run.id);
      await runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'durable stop',
        abortSignal: controller.signal,
      });

      expect(registry.getRun(run.id)?.status).toBe('cancelled');
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('calls cleanup after a failed stream and swallows cleanup errors', async () => {
      const registry = new RunRegistry();
      const cleanup = vi.fn(() => {
        throw new Error('pubsub already gone');
      });
      const agent: RunnableAgent = {
        stream: async () => ({
          fullStream: streamOf([
            { type: 'error', payload: { error: 'gateway down' } },
          ]).fullStream,
          cleanup,
        }),
        getMemory: async () => undefined,
      };
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'durable fail',
        requestAbort: () => undefined,
      });

      await expect(
        runExecution(registry, agent, {
          runId: run.id,
          ...TUPLE,
          prompt: 'durable fail',
          abortSignal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();

      expect(registry.getRun(run.id)?.status).toBe('failed');
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('never calls cleanup when stream() itself throws (no result to release)', async () => {
      const registry = new RunRegistry();
      const cleanup = vi.fn();
      const agent: RunnableAgent = {
        stream: async () => {
          throw new Error('workflow start failed');
        },
        getMemory: async () => undefined,
      };
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'no stream',
        requestAbort: () => undefined,
      });

      await runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'no stream',
        abortSignal: new AbortController().signal,
      });

      expect(registry.getRun(run.id)?.status).toBe('failed');
      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  describe('cancelled turn persistence (abort bridge)', () => {
    const PARAMS = {
      runId: 'run_20260824120000_abcd1234',
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'analyze the market',
    };

    function event(
      type: AgentRunEvent['type'],
      payload: Record<string, unknown>,
    ): AgentRunEvent {
      return { sequence: 0, type, payload, createdAt: '2026-08-24T12:00:00Z' };
    }

    it('builds the user message from the prompt and the assistant partial from events', () => {
      const [user, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('text-delta', { text: 'Found 3 competitors. ' }),
        event('tool-call', { toolCallId: 'tc-1', toolName: 'search_web', args: { query: 'x' } }),
        event('tool-result', { toolCallId: 'tc-1', toolName: 'search_web', result: { results: [] } }),
        event('text-delta', { text: 'Reading pages…' }),
      ]);

      expect(user.id).toBe(`${PARAMS.runId}-user`);
      expect(user.role).toBe('user');
      expect(user.content).toEqual({
        format: 2,
        parts: [{ type: 'text', text: 'analyze the market' }],
      });

      expect(assistant.id).toBe(`${PARAMS.runId}-assistant`);
      expect(assistant.role).toBe('assistant');
      const parts = assistant.content.parts as Array<Record<string, unknown>>;
      // Tool activity persists as `tool-invocation` parts — the only shape
      // Mastra's recall conversion keeps in the model prompt.
      expect(parts[0]).toMatchObject({
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: 'tc-1',
          toolName: 'search_web',
          state: 'result',
          args: { query: 'x' },
          result: { results: [] },
        },
      });
      const textPart = parts[parts.length - 1] as { type: string; text: string };
      expect(textPart.type).toBe('text');
      expect(textPart.text).toContain('Found 3 competitors. Reading pages…');
      expect(textPart.text).toContain('Run dihentikan');
    });

    it('pairs an interrupted tool-call with a synthetic error outcome the next provider request needs', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-9', toolName: 'read_web_page', args: { url: 'https://x' } }),
      ]);

      const parts = assistant.content.parts as Array<Record<string, unknown>>;
      const invocation = (
        parts.find((part) => part.type === 'tool-invocation') as {
          toolInvocation: Record<string, unknown>;
        }
      )?.toolInvocation;
      expect(invocation).toMatchObject({
        toolCallId: 'tc-9',
        toolName: 'read_web_page',
        state: 'output-error',
      });
      expect(String(invocation?.errorText)).toContain('interrupted');
    });

    it('stamps synthetic interrupted invocations so restored cards are not errors', () => {
      // The client restore path reads this marker; without it the persisted
      // `output-error` state renders the stopped tool as a failure after a
      // page refresh (N9_3 action item 1).
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-inflight', toolName: 'read_web_page' }),
        event('tool-call', { toolCallId: 'tc-done', toolName: 'search_web' }),
        event('tool-result', { toolCallId: 'tc-done', toolName: 'search_web', result: 'ok' }),
      ]);

      const parts = assistant.content.parts as Array<{
        type: string;
        toolInvocation?: Record<string, unknown>;
      }>;
      const inflight = parts.find(
        (part) => part.toolInvocation?.toolCallId === 'tc-inflight',
      )?.toolInvocation;
      const done = parts.find(
        (part) => part.toolInvocation?.toolCallId === 'tc-done',
      )?.toolInvocation;
      expect(inflight?.interrupted).toBe(true);
      expect(done?.interrupted).toBeUndefined();
      expect(done?.state).toBe('result');
      expect(done?.result).toBe('ok');
    });

    it('keeps a genuine tool failure distinguishable from an interrupted one', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-fail', toolName: 'search_web' }),
        event('tool-error', { toolCallId: 'tc-fail', toolName: 'search_web', error: 'engine exploded' }),
      ]);

      const parts = assistant.content.parts as Array<{
        toolInvocation?: Record<string, unknown>;
      }>;
      const failed = parts[0]?.toolInvocation;
      expect(failed).toMatchObject({
        toolCallId: 'tc-fail',
        state: 'output-error',
        errorText: 'engine exploded',
      });
      expect(failed?.interrupted).toBeUndefined();
    });

    it('timestamps the user prompt before the assistant partial so the pair restores in order', () => {
      // The Postgres store tie-breaks equal createdAt by message id, and
      // `${runId}-assistant` sorts before `${runId}-user`; equal timestamps
      // restored the assistant bubble above the user prompt (N9_3 action
      // item 1). The assistant row must land strictly later.
      const [user, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-1', toolName: 'search_web' }),
      ]);

      expect(user.createdAt.getTime()).toBeLessThan(assistant.createdAt.getTime());
    });

    it('bounds oversized tool results and tool args in the reconstructed turn', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', {
          toolCallId: 'tc-1',
          toolName: 'read_web_page',
          args: { url: `https://x/${'a'.repeat(4_000)}` },
        }),
        event('tool-result', {
          toolCallId: 'tc-1',
          toolName: 'read_web_page',
          result: { markdown: 'x'.repeat(10_000) },
        }),
      ]);

      const parts = assistant.content.parts as Array<{
        toolInvocation?: { result?: unknown; args?: unknown };
      }>;
      const invocation = parts[0]?.toolInvocation;
      expect(String(invocation?.result)).toContain('…[truncated]');
      expect(String(invocation?.args)).toContain('…[truncated]');
      expect(String(invocation?.args).length).toBeLessThanOrEqual(2_100);
    });

    it('clamps an over-long streamed text head+tail with a visible marker', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('text-delta', { text: `HEAD${'a'.repeat(20_000)}` }),
        event('text-delta', { text: `${'b'.repeat(20_000)}MIDDLE${'c'.repeat(20_000)}` }),
        event('text-delta', { text: `${'d'.repeat(20_000)}TAIL` }),
      ]);

      const parts = assistant.content.parts as Array<{ type: string; text?: string }>;
      const textPart = parts[parts.length - 1];
      expect(textPart.text).toContain('HEAD');
      expect(textPart.text).toContain('TAIL');
      expect(textPart.text).not.toContain('MIDDLE');
      expect(textPart.text).toContain('teks terpotong');
      // 24k head+tail budget + markers, never a multi-megabyte row.
      expect(textPart.text!.length).toBeLessThan(26_500);
    });

    it('marks image attachments as not retained for multimodal cancelled turns', () => {
      const [user] = buildCancelledTurnMessages(
        { ...PARAMS, content: [{ type: 'text', text: 'see this' }, { type: 'image', image: 'QUJD', mimeType: 'image/png', filename: 'shot.png' }] },
        [],
      );
      const parts = user.content.parts as Array<{ type: string; text: string }>;
      expect(parts[0]).toEqual({ type: 'text', text: 'see this' });
      expect(parts[1].text).toContain('shot.png');
    });

    it('survives recall through the real MessageList: tool evidence reaches the next model prompt', () => {
      // The bridge shape must round-trip through @mastra/core's recall
      // conversion (MessageList -> aiV5 prompt): raw tool-call/tool-result
      // parts are skipped there, which is exactly the bug this shape fixes.
      const [user, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-done', toolName: 'search_web', args: { query: 'competitors' } }),
        event('tool-result', { toolCallId: 'tc-done', toolName: 'search_web', result: 'evidence payload' }),
        event('tool-call', { toolCallId: 'tc-inflight', toolName: 'read_web_page', args: { url: 'https://x' } }),
        event('text-delta', { text: 'Partial analysis' }),
      ]);

      const list = new MessageList();
      list.add([user, assistant] as never, 'memory');
      const prompt = JSON.stringify(list.get.all.aiV5.prompt());

      // Completed tool: its call and result stay in the model context.
      expect(prompt).toContain('search_web');
      expect(prompt).toContain('tc-done');
      expect(prompt).toContain('evidence payload');
      // Interrupted tool: the synthetic error result keeps the request valid.
      expect(prompt).toContain('tc-inflight');
      expect(prompt).toContain('interrupted before completing');
      // Streamed partial text and stop marker survive.
      expect(prompt).toContain('Partial analysis');
      expect(prompt).toContain('Run dihentikan');
    });

    it('keeps the old raw tool-call/tool-result shape out of the prompt (regression guard)', () => {
      // Documents the P1: recall conversion drops raw tool parts, so the
      // bridge must never go back to writing them.
      const raw = [
        {
          id: 'raw-user',
          role: 'user',
          createdAt: new Date(),
          threadId: TUPLE.threadId,
          resourceId: TUPLE.resourceId,
          content: { format: 2, parts: [{ type: 'text', text: 'analyze the market' }] },
        },
        {
          id: 'raw-assistant',
          role: 'assistant',
          createdAt: new Date(Date.now() + 1),
          threadId: TUPLE.threadId,
          resourceId: TUPLE.resourceId,
          content: {
            format: 2,
            parts: [
              { type: 'tool-call', toolCallId: 'tc-raw', toolName: 'search_web', input: { query: 'x' } },
              { type: 'tool-result', toolCallId: 'tc-raw', toolName: 'search_web', output: 'evidence' },
              { type: 'text', text: 'partial only' },
            ],
          },
        },
      ];

      const list = new MessageList();
      list.add(raw as never, 'memory');
      const prompt = JSON.stringify(list.get.all.aiV5.prompt());

      expect(prompt).toContain('partial only');
      expect(prompt).toContain('analyze the market');
      expect(prompt).not.toContain('tc-raw');
      expect(prompt).not.toContain('search_web');
    });

    it('persists new cancelled messages through memory.saveMessages and never throws', async () => {
      const registry = new RunRegistry();
      const saveMessages = vi.fn();
      const memory: MemoryAccess = {
        getThreadById: async () => null,
        createThread: async () => undefined,
        saveMessages,
      };
      const agent: RunnableAgent = {
        stream: async () => streamOf([]),
        getMemory: async () => memory,
      };
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'stop me',
        requestAbort: () => undefined,
      });
      registry.requestCancel(run.id);

      await persistCancelledTurn(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'stop me',
        abortSignal: new AbortController().signal,
      });

      expect(saveMessages).toHaveBeenCalledTimes(1);
      const persisted = saveMessages.mock.calls[0]?.[0]?.messages as Array<{ id: string }>;
      expect(persisted.map(({ id }) => id)).toEqual([`${run.id}-user`, `${run.id}-assistant`]);
    });

    it('persists the partial turn when a watchdog force-fail aborted the stream', async () => {
      // The duration watchdog latches the cancel intent, aborts the signal,
      // and finishes the run as failed before the driver unwinds. The
      // driver must still persist the partial turn (blank-thread bug) and
      // must not overwrite the watchdog's terminal status.
      const registry = new RunRegistry();
      const saveMessages = vi.fn();
      const memory: MemoryAccess = {
        getThreadById: async () => null,
        createThread: async () => undefined,
        saveMessages,
      };
      const agent: RunnableAgent = {
        stream: async () => streamOf([]),
        getMemory: async () => memory,
      };
      const controller = new AbortController();
      const run = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'long research',
        requestAbort: () => controller.abort(),
      });
      registry.requestCancel(run.id);
      registry.finishRun(run.id, 'failed', 'Run exceeded the maximum duration.');

      await runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'long research',
        abortSignal: controller.signal,
      });

      const final = registry.getRun(run.id);
      expect(final?.status).toBe('failed');
      expect(final?.error).toBe('Run exceeded the maximum duration.');
      expect(saveMessages).toHaveBeenCalledTimes(1);
    });

    it('runExecution persists the cancelled turn and skips completed runs', async () => {
      const registry = new RunRegistry();
      const saveMessages = vi.fn();
      const memory: MemoryAccess = {
        getThreadById: async () => null,
        createThread: async () => undefined,
        saveMessages,
      };

      const cancelledAgent: RunnableAgent = {
        stream: async () => streamOf([
          { type: 'text-delta', payload: { text: 'partial' } },
        ]),
        getMemory: async () => memory,
      };
      const controller = new AbortController();
      const cancelledRun = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'cancel me',
        requestAbort: () => controller.abort(),
      });
      registry.requestCancel(cancelledRun.id);
      await runExecution(registry, cancelledAgent, {
        runId: cancelledRun.id,
        ...TUPLE,
        prompt: 'cancel me',
        abortSignal: controller.signal,
      });
      expect(registry.getRun(cancelledRun.id)?.status).toBe('cancelled');
      expect(saveMessages).toHaveBeenCalledTimes(1);

      const completedAgent: RunnableAgent = {
        stream: async () => streamOf([
          { type: 'text-delta', payload: { text: 'done' } },
        ]),
        getMemory: async () => memory,
      };
      const completedRun = registry.createRun({
        id: createRunId(),
        ...TUPLE,
        prompt: 'finish me',
        requestAbort: () => undefined,
      });
      await runExecution(registry, completedAgent, {
        runId: completedRun.id,
        ...TUPLE,
        prompt: 'finish me',
        abortSignal: new AbortController().signal,
      });
      // Mastra persists completed turns itself; the bridge must not duplicate.
      expect(registry.getRun(completedRun.id)?.status).toBe('completed');
      expect(saveMessages).toHaveBeenCalledTimes(1);
    });
  });
});

describe('generateFirstTurnTitle (durable driver-side titles)', () => {
  const TITLE_PARAMS = {
    runId: 'run_20260824120000_abcd1234',
    ...TUPLE,
    prompt: 'analyze the market',
    firstTurn: true,
    abortSignal: new AbortController().signal,
  };

  function makeTitleMemory(existingTitle?: string) {
    let currentTitle = existingTitle;
    const calls: {
      titles: Array<string | undefined>;
      metadata: Array<Record<string, unknown> | undefined>;
    } = { titles: [], metadata: [] };
    const memory: MemoryAccess = {
      getThreadById: async () => ({ title: currentTitle, metadata: { keep: true } }),
      createThread: async (params) => {
        calls.titles.push(params.title);
        calls.metadata.push(params.metadata);
        currentTitle = params.title;
        return params;
      },
      getMergedThreadConfig: () => ({ generateTitle: true }),
    };
    return { memory, calls };
  }

  /** Real durable wrapper (instanceof gate) with faked genTitle. */
  function makeDurableTitleAgent(memory: MemoryAccess) {
    const genTitle = vi.fn(
      async (_userMessage: string) => 'Analisis pasar kompetitor',
    );
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'durable-title-agent',
        name: 'Durable Title',
        instructions: 'test agent',
        model: () => 'openai/gateway/test-model',
        memory: memory as never,
      }),
    });
    (
      agent as unknown as { genTitle: typeof genTitle }
    ).genTitle = genTitle;
    return { agent, genTitle };
  }

  it('titles an untitled durable first turn through the memory upsert', async () => {
    const { memory, calls } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);

    await generateFirstTurnTitle(agent, TITLE_PARAMS);

    expect(genTitle).toHaveBeenCalledTimes(1);
    expect(genTitle.mock.calls[0]?.slice(0, 2)).toEqual(['analyze the market', undefined]);
    expect(calls.titles).toEqual(['Analisis pasar kompetitor']);
    expect(calls.metadata).toEqual([{ keep: true }]);
  });

  it('feeds the title generator from multimodal text parts', async () => {
    const { memory } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);

    await generateFirstTurnTitle(agent, {
      ...TITLE_PARAMS,
      content: [
        { type: 'text', text: 'see this chart' },
        { type: 'image', image: 'QUJD', mimeType: 'image/png' },
      ],
    });

    expect(genTitle.mock.calls[0]?.[0]).toBe('see this chart');
  });

  it('skips a thread that already carries a title', async () => {
    const { memory, calls } = makeTitleMemory('Manual rename');
    const { agent, genTitle } = makeDurableTitleAgent(memory);

    await generateFirstTurnTitle(agent, TITLE_PARAMS);

    expect(genTitle).not.toHaveBeenCalled();
    expect(calls.titles).toEqual([]);
  });

  it('skips when the memory has no generateTitle opt-in (stored agents)', async () => {
    const memory: MemoryAccess = {
      getThreadById: async () => ({ title: undefined }),
      createThread: async () => undefined,
      getMergedThreadConfig: () => ({}),
    };
    const { agent, genTitle } = makeDurableTitleAgent(memory);

    await generateFirstTurnTitle(agent, TITLE_PARAMS);

    expect(genTitle).not.toHaveBeenCalled();
  });

  it('skips plain agents — their native finish path already titles the thread', async () => {
    const { memory } = makeTitleMemory(undefined);
    const genTitle = vi.fn(async () => 'should not run');
    const agent: RunnableAgent = {
      stream: async () => streamOf([]),
      getMemory: async () => memory,
      genTitle,
    } as unknown as RunnableAgent;

    await generateFirstTurnTitle(agent, TITLE_PARAMS);

    expect(genTitle).not.toHaveBeenCalled();
  });

  it('keeps a manual rename that lands during title generation', async () => {
    let renamed = false;
    const calls: Array<string | undefined> = [];
    const memory: MemoryAccess = {
      getThreadById: async () => ({
        title: renamed ? 'Renamed mid-flight' : undefined,
      }),
      createThread: async (params) => {
        calls.push(params.title);
        return params;
      },
      getMergedThreadConfig: () => ({ generateTitle: true }),
    };
    const genTitle = vi.fn(async () => {
      renamed = true; // the rename lands while the LLM generates
      return 'Too late';
    });
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'durable-race-agent',
        name: 'Durable Race',
        instructions: 'test agent',
        model: () => 'openai/gateway/test-model',
        memory: memory as never,
      }),
    });
    (agent as unknown as { genTitle: typeof genTitle }).genTitle = genTitle;

    await generateFirstTurnTitle(agent, TITLE_PARAMS);

    expect(calls).toEqual([]);
  });

  it('skips later turns (firstTurn flag absent)', async () => {
    const { memory, calls } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);

    const { firstTurn: _omit, ...laterTurn } = TITLE_PARAMS;
    await generateFirstTurnTitle(agent, laterTurn);

    expect(genTitle).not.toHaveBeenCalled();
    expect(calls.titles).toEqual([]);
  });

  it('never throws — a title failure leaves the completed run untouched', async () => {
    const { memory } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);
    genTitle.mockRejectedValue(new Error('gateway down'));

    await expect(
      generateFirstTurnTitle(agent, TITLE_PARAMS),
    ).resolves.toBeUndefined();
  });

  it('runs after a durable first-turn run completes inside runExecution', async () => {
    const { memory, calls } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);
    (agent as unknown as RunnableAgent & { stream: RunnableAgent['stream'] }).stream =
      async () => streamOf([{ type: 'text-delta', payload: { text: 'done' } }]);

    const registry = new RunRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'analyze the market',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      ...TITLE_PARAMS,
      runId: run.id,
      firstTurn: true,
    });

    expect(registry.getRun(run.id)?.status).toBe('completed');
    expect(genTitle).toHaveBeenCalledTimes(1);
    expect(calls.titles).toEqual(['Analisis pasar kompetitor']);
  });

  it('does not title a failed run inside runExecution', async () => {
    const { memory } = makeTitleMemory(undefined);
    const { agent, genTitle } = makeDurableTitleAgent(memory);
    (agent as unknown as RunnableAgent & { stream: RunnableAgent['stream'] }).stream =
      async () => streamOf([{ type: 'error', payload: { error: 'gateway down' } }]);

    const registry = new RunRegistry();
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'analyze the market',
      requestAbort: () => undefined,
    });

    await runExecution(registry, agent, {
      ...TITLE_PARAMS,
      runId: run.id,
      firstTurn: true,
    });

    expect(registry.getRun(run.id)?.status).toBe('failed');
    expect(genTitle).not.toHaveBeenCalled();
  });
});
