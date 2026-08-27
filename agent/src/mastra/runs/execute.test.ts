import { describe, expect, it, vi } from 'vitest';
import { RunRegistry, createRunId, type AgentRunEvent } from './run-registry.js';
import {
  buildCancelledTurnMessages,
  buildThreadTitle,
  chunkToRunEvent,
  ensureFirstTurnThread,
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
  const calls: { titles: string[] } = { titles: [] };
  const memory: MemoryAccess = {
    getThreadById: async () => (existing ? { metadata: { kept: true } } : null),
    createThread: async (params) => {
      calls.titles.push(params.title ?? '');
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

describe('buildThreadTitle', () => {
  it('uses the prompt unchanged up to 52 characters', () => {
    expect(buildThreadTitle('short prompt')).toBe('short prompt');
  });

  it('truncates long prompts the same way the client did', () => {
    const long = 'a'.repeat(60);
    const title = buildThreadTitle(long);
    expect(title.length).toBe(50);
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not split surrogate pairs when truncating', () => {
    // 48 BMP chars + one astral emoji + 10 more: the 49-code-point cut
    // lands right after the emoji, where a UTF-16 slice(0, 49) would have
    // kept only the high surrogate.
    const prompt = `${'a'.repeat(48)}😀${'b'.repeat(10)}`;

    expect(buildThreadTitle(prompt)).toBe(`${'a'.repeat(48)}😀…`);
  });

  it('keeps astral prompts within the character budget untruncated', () => {
    // 52 code points (one astral) is 53 UTF-16 units; the budget counts
    // characters, so it must not be truncated.
    const prompt = `${'a'.repeat(51)}😀`;
    expect(buildThreadTitle(prompt)).toBe(prompt);
  });
});

describe('ensureFirstTurnThread', () => {
  it('creates the missing thread record titled from the prompt', async () => {
    const { memory, calls } = makeMemory(false);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'research the market',
    });

    expect(calls.titles).toEqual(['research the market']);
  });

  it('truncates long prompts into the thread title', async () => {
    const { memory, calls } = makeMemory(false);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'a'.repeat(60),
    });

    expect(calls.titles).toEqual([buildThreadTitle('a'.repeat(60))]);
  });

  it('leaves an existing thread untouched', async () => {
    const { memory, calls } = makeMemory(true);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'second turn',
    });

    expect(calls.titles).toEqual([]);
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
    // Titles are owned by ensureFirstTurnThread at run start, not execution.
    expect(memoryCalls.titles).toEqual([]);
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
      expect(parts[0]).toMatchObject({ type: 'tool-call', toolCallId: 'tc-1', input: { query: 'x' } });
      expect(parts[1]).toMatchObject({ type: 'tool-result', toolCallId: 'tc-1', output: { results: [] } });
      const textPart = parts[parts.length - 1] as { type: string; text: string };
      expect(textPart.type).toBe('text');
      expect(textPart.text).toContain('Found 3 competitors. Reading pages…');
      expect(textPart.text).toContain('Run dihentikan');
    });

    it('pairs an interrupted tool-call with a synthetic tool-result the next provider request needs', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-9', toolName: 'read_web_page', args: { url: 'https://x' } }),
      ]);

      const parts = assistant.content.parts as Array<Record<string, unknown>>;
      const synthetic = parts.find(
        (part) =>
          part.type === 'tool-result' &&
          part.toolCallId === 'tc-9' &&
          (part.output as { type?: string })?.type === 'error-text',
      );
      expect(synthetic).toBeDefined();
      expect((synthetic?.output as { value: string }).value).toContain('interrupted');
    });

    it('stamps synthetic tool-results with the interrupted marker so restored cards are not errors', () => {
      // The client restore path reads this marker; without it the persisted
      // `error-text` output renders the stopped tool as a failure after a
      // page refresh (N9_3 action item 1).
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-inflight', toolName: 'read_web_page' }),
        event('tool-call', { toolCallId: 'tc-done', toolName: 'search_web' }),
        event('tool-result', { toolCallId: 'tc-done', toolName: 'search_web', result: 'ok' }),
      ]);

      const parts = assistant.content.parts as Array<Record<string, unknown>>;
      const inflight = parts.find((part) => part.type === 'tool-result' && part.toolCallId === 'tc-inflight');
      const done = parts.find((part) => part.type === 'tool-result' && part.toolCallId === 'tc-done');
      expect(inflight?.interrupted).toBe(true);
      expect(done?.interrupted).toBeUndefined();
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

    it('bounds oversized tool results in the reconstructed turn', () => {
      const [, assistant] = buildCancelledTurnMessages(PARAMS, [
        event('tool-call', { toolCallId: 'tc-1', toolName: 'read_web_page' }),
        event('tool-result', {
          toolCallId: 'tc-1',
          toolName: 'read_web_page',
          result: { markdown: 'x'.repeat(10_000) },
        }),
      ]);

      const parts = assistant.content.parts as Array<Record<string, unknown>>;
      const result = parts.find((part) => part.type === 'tool-result');
      expect(String(result?.output)).toContain('…[truncated]');
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
