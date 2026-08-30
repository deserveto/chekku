import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_CAPACITY_PER_RESOURCE_MESSAGE,
  RunRegistry,
  createRunId,
} from '../runs/run-registry.js';
import { TokenQuotaExceededError } from '../runs/token-quota.js';
import {
  MAX_CONTENT_FILENAME_CHARS,
  MAX_CONTENT_IMAGE_BASE64_CHARS,
  MAX_CONTENT_PARTS,
  MAX_CONTENT_TEXT_CHARS,
  MAX_PROMPT_UTF8_BYTES,
  cancelRunRoute,
  parseStartRunRequest,
  resolveAgent,
  runEventsRoute,
  runStatusRoute,
  startRunRoute,
} from './runs.js';

// The run routes close over the module-level `agentRunRegistry` singleton.
// Swap it for a fresh registry per test so handler-level tests exercise
// real registry behavior without global state leaking between cases.
const registryState = vi.hoisted(() => ({
  registry: undefined as unknown as RunRegistry,
}));

vi.mock('../runs/run-registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../runs/run-registry.js')>();
  return {
    ...actual,
    get agentRunRegistry() {
      return registryState.registry;
    },
  };
});

// Same pattern as the registry: swap the module-level tokenQuotaStore
// singleton per test so handler-level tests control quota state.
const quotaState = vi.hoisted(() => ({
  store: undefined as unknown as {
    assertQuota: (resourceId: string) => void;
    consume: (resourceId: string, tokens: number) => void;
  },
}));

vi.mock('../runs/token-quota.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../runs/token-quota.js')>();
  return {
    ...actual,
    get tokenQuotaStore() {
      return quotaState.store;
    },
  };
});

beforeEach(() => {
  registryState.registry = new RunRegistry();
  quotaState.store = {
    assertQuota: () => undefined,
    consume: () => undefined,
  };
});

const VALID = {
  agentId: 'main-agent',
  threadId: 'main-agent-user-1-uuid-a',
  resourceId: 'user-1',
  prompt: 'Hello there',
};

const agentLike = {
  stream: () => undefined,
  getMemory: async () => undefined,
};

describe('resolveAgent', () => {
  it('resolves by public agent id via getAgentById, not registry keys', () => {
    // Chekku registers agents under composition keys (mainAgent, pmAgent,
    // ...); the public id ('main-agent') lives on the agent itself. This
    // regressed once as "Unknown agent" for every agent in the UI.
    const context = {
      get: (key: string) =>
        key === 'mastra'
          ? {
              getAgentById: (id: string) =>
                id === 'main-agent' ? agentLike : undefined,
            }
          : undefined,
    };

    expect(resolveAgent(context as never, 'main-agent')).toBe(agentLike);
    expect(resolveAgent(context as never, 'no-such-agent')).toBeNull();
  });

  it('returns null when the mastra instance or agent shape is missing', () => {
    expect(resolveAgent({} as never, 'main-agent')).toBeNull();
    expect(
      resolveAgent(
        {
          get: () => ({
            getAgentById: () => ({ stream: () => undefined }),
          }),
        } as never,
        'main-agent',
      ),
    ).toBeNull();
    expect(
      resolveAgent(
        {
          get: () => ({
            getAgentById: () => {
              throw new Error('not found');
            },
          }),
        } as never,
        'main-agent',
      ),
    ).toBeNull();
  });
});

describe('parseStartRunRequest', () => {
  it('accepts a valid start payload and trims the prompt', () => {
    const result = parseStartRunRequest({ ...VALID, prompt: '  hi  ' });
    expect(result).toEqual({
      ok: true,
      value: { ...VALID, prompt: 'hi' },
    });
  });

  it('accepts validated multimodal content without copying it into the prompt', () => {
    const content = [
      { type: 'text', text: '[Attached image: photo.png]' },
      { type: 'image', image: 'QUJD', mimeType: 'image/png' },
    ];
    const result = parseStartRunRequest({ ...VALID, content });

    expect(result).toEqual({
      ok: true,
      value: { ...VALID, content },
    });
  });

  it('rejects malformed multimodal content', () => {
    expect(
      parseStartRunRequest({
        ...VALID,
        content: [{ type: 'image', image: 'QUJD', mimeType: 'text/plain' }],
      }),
    ).toEqual({
      ok: false,
      error: 'content must be valid multimodal message parts',
    });
  });

  it('accepts a bounded filename on image parts', () => {
    const result = parseStartRunRequest({
      ...VALID,
      content: [
        { type: 'image', image: 'QUJD', mimeType: 'image/png', filename: 'a.png' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toEqual([
        { type: 'image', image: 'QUJD', mimeType: 'image/png', filename: 'a.png' },
      ]);
    }
  });

  it('rejects content that exceeds the part or size caps', () => {
    const image = { type: 'image', image: 'QUJD', mimeType: 'image/png' };
    const tooManyParts = parseStartRunRequest({
      ...VALID,
      content: Array.from({ length: MAX_CONTENT_PARTS + 1 }, () => image),
    });
    expect(tooManyParts).toEqual({
      ok: false,
      error: 'content must be valid multimodal message parts',
    });

    const hugeImage = 'Q'.repeat(MAX_CONTENT_IMAGE_BASE64_CHARS + 1);
    expect(
      parseStartRunRequest({
        ...VALID,
        content: [{ type: 'image', image: hugeImage, mimeType: 'image/png' }],
      }).ok,
    ).toBe(false);

    const perPart = 'Q'.repeat(1_700_000);
    const overTotal = parseStartRunRequest({
      ...VALID,
      content: Array.from({ length: 5 }, () => ({
        type: 'image',
        image: perPart,
        mimeType: 'image/png',
      })),
    });
    expect(overTotal).toEqual({
      ok: false,
      error: 'content must be valid multimodal message parts',
    });

    const hugeText = 'Q'.repeat(MAX_CONTENT_TEXT_CHARS + 1);
    expect(
      parseStartRunRequest({
        ...VALID,
        content: [{ type: 'text', text: hugeText }],
      }).ok,
    ).toBe(false);

    const hugeFilename = 'f'.repeat(MAX_CONTENT_FILENAME_CHARS + 1);
    expect(
      parseStartRunRequest({
        ...VALID,
        content: [
          {
            type: 'image',
            image: 'QUJD',
            mimeType: 'image/png',
            filename: hugeFilename,
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('rejects data: URL image values', () => {
    expect(
      parseStartRunRequest({
        ...VALID,
        content: [
          {
            type: 'image',
            image: 'data:image/png;base64,QUJD',
            mimeType: 'image/png',
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: 'content must be valid multimodal message parts',
    });
  });

  it('rejects an empty content array the same as malformed content', () => {
    expect(parseStartRunRequest({ ...VALID, content: [] })).toEqual({
      ok: false,
      error: 'content must be valid multimodal message parts',
    });
  });

  it('rejects non-object bodies', () => {
    expect(parseStartRunRequest(null)).toEqual({
      ok: false,
      error: 'Request body must be a JSON object',
    });
    expect(parseStartRunRequest('[]' as unknown)).toEqual({
      ok: false,
      error: 'Request body must be a JSON object',
    });
  });

  it('rejects malformed agent and resource ids', () => {
    expect(parseStartRunRequest({ ...VALID, agentId: 'MAIN' }).ok).toBe(false);
    expect(parseStartRunRequest({ ...VALID, resourceId: 'user 1' }).ok).toBe(
      false,
    );
  });

  it('rejects threads owned by another agent or resource', () => {
    const result = parseStartRunRequest({
      ...VALID,
      threadId: 'pm-agent-user-1-uuid-a',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Thread does not belong to this agent and resource',
    });
  });

  it('rejects missing and oversized prompts', () => {
    expect(parseStartRunRequest({ ...VALID, prompt: '   ' }).ok).toBe(false);
    expect(parseStartRunRequest({ ...VALID, prompt: 42 as unknown }).ok).toBe(
      false,
    );

    const huge = 'x'.repeat(MAX_PROMPT_UTF8_BYTES + 1);
    expect(parseStartRunRequest({ ...VALID, prompt: huge })).toEqual({
      ok: false,
      error: 'prompt exceeds the maximum length',
    });
  });
});

// ---------------------------------------------------------------------------
// Handler-level tests: invoke the registered route handlers directly with a
// minimal context double and the per-test registry installed above.
// ---------------------------------------------------------------------------

type RouteHandler = (c: unknown) => Response | Promise<Response>;

/** ApiRoute is a union of static-handler and createHandler routes; narrow it. */
function handlerOf(route: { handler?: unknown; createHandler?: unknown }): RouteHandler {
  if (typeof route.handler !== 'function') {
    throw new Error('Expected a route with a static handler');
  }
  return route.handler as RouteHandler;
}

const startHandler = handlerOf(startRunRoute);
const statusHandler = handlerOf(runStatusRoute);
const eventsHandler = handlerOf(runEventsRoute);
const cancelHandler = handlerOf(cancelRunRoute);

const runnableAgent = {
  stream: async () => ({
    fullStream: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  }),
  getMemory: async () => undefined,
};

type HandlerContextOverrides = {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  signal?: AbortSignal;
  mastra?: unknown;
};

function makeContext(overrides: HandlerContextOverrides = {}) {
  return {
    req: {
      json: async () => overrides.body ?? null,
      param: (name: string) => overrides.params?.[name],
      query: (name: string) => overrides.query?.[name],
      raw: { signal: overrides.signal ?? new AbortController().signal },
    },
    get: (key: string) => (key === 'mastra' ? overrides.mastra : undefined),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

const FOREIGN_RESOURCE = 'user-2';

function seedRunningRun(
  resourceId: string = 'user-1',
  threadId: string = 'main-agent-user-1-uuid-a',
) {
  return registryState.registry.createRun({
    id: createRunId(),
    agentId: 'main-agent',
    threadId,
    resourceId,
    prompt: 'seeded prompt',
    requestAbort: () => undefined,
  });
}

describe('run routes: ownership collapses foreign runs to 404', () => {
  it('status, events, and cancel routes return 404 for another resource', async () => {
    const run = seedRunningRun();
    const query = { resourceId: FOREIGN_RESOURCE };

    const status = await statusHandler(
      makeContext({ params: { runId: run.id }, query }) as never,
    );
    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: 'Run not found' });

    const events = await eventsHandler(
      makeContext({
        params: { runId: run.id },
        query: { ...query, offset: '0' },
      }) as never,
    );
    expect(events.status).toBe(404);

    const cancel = await cancelHandler(
      makeContext({ params: { runId: run.id }, query }) as never,
    );
    expect(cancel.status).toBe(404);

    // The 404 must not have aborted or exposed the foreign run.
    expect(registryState.registry.getRun(run.id)?.status).toBe('running');
  });

  it('status and cancel routes return 404 for unknown run ids', async () => {
    const unknown = 'run_20260101000000_00000000';
    const query = { resourceId: 'user-1' };

    expect(
      (
        await statusHandler(
          makeContext({ params: { runId: unknown }, query }) as never,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await cancelHandler(
          makeContext({ params: { runId: unknown }, query }) as never,
        )
      ).status,
    ).toBe(404);
  });
});

describe('run routes: concurrency cap surfaces as 429', () => {
  function startContext(threadId: string, resourceId: string) {
    return makeContext({
      body: { agentId: 'main-agent', threadId, resourceId, prompt: 'task' },
      mastra: { getAgentById: () => runnableAgent },
    }) as never;
  }

  it('rejects the 5th concurrent run for a resource without corrupting state', async () => {
    for (let i = 0; i < 4; i++) {
      seedRunningRun('user-1', `main-agent-user-1-uuid-${i}`);
    }

    const response = await startHandler(
      startContext('main-agent-user-1-uuid-new', 'user-1'),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe(RUN_CAPACITY_PER_RESOURCE_MESSAGE);

    // Registry state stays intact and another user is unaffected.
    expect(registryState.registry.listActiveRuns('user-1')).toHaveLength(4);
    const other = await startHandler(
      startContext('main-agent-user-2-uuid-a', FOREIGN_RESOURCE),
    );
    expect(other.status).toBe(202);
  });

  it('still returns 409 with the active run for a duplicate thread start at cap', async () => {
    const run = seedRunningRun();
    for (let i = 1; i < 4; i++) {
      seedRunningRun('user-1', `main-agent-user-1-uuid-${i}`);
    }

    const response = await startHandler(
      startContext('main-agent-user-1-uuid-a', 'user-1'),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { run?: { id?: string } };
    expect(body.run?.id).toBe(run.id);
  });
});

describe('run events route: heartbeat lifecycle', () => {
  it('replaying a completed run closes the stream and leaves no interval behind', async () => {
    vi.useFakeTimers();
    try {
      const run = seedRunningRun();
      registryState.registry.finishRun(run.id, 'completed');

      const response = await eventsHandler(
        makeContext({
          params: { runId: run.id },
          query: { resourceId: 'user-1', offset: '0' },
        }) as never,
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"type":"finish"');
      // subscribeFrom replays the terminal event synchronously, closing
      // the stream before subscribe returns; the heartbeat scheduled for
      // the stream must be cleared, not orphaned for the process life.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the heartbeat when the request aborts on a live run', async () => {
    vi.useFakeTimers();
    try {
      const run = seedRunningRun();
      registryState.registry.appendEvent(run.id, 'text-delta', {
        text: 'partial',
      });
      const controller = new AbortController();

      const response = await eventsHandler(
        makeContext({
          params: { runId: run.id },
          query: { resourceId: 'user-1', offset: '0' },
          signal: controller.signal,
        }) as never,
      );

      expect(response.status).toBe(200);
      // No terminal replay: the heartbeat keeps the connection alive...
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      // ...and the abort listener closes the stream, clearing it.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('run routes: token quota gate', () => {
  function blockedQuota() {
    quotaState.store = {
      assertQuota: () => {
        throw new TokenQuotaExceededError(500_000, 500_000);
      },
      consume: () => undefined,
    };
  }

  function mastraWithAgent() {
    return {
      getAgentById: (id: string) => (id === 'main-agent' ? runnableAgent : undefined),
    };
  }

  it('returns 429 with the fixed message when the quota is exhausted', async () => {
    blockedQuota();
    const res = await startHandler(
      makeContext({ body: { ...VALID }, mastra: mastraWithAgent() }) as never,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error:
        'Daily token limit reached (500,000 of 500,000 tokens used). Resets at midnight UTC.',
    });
  });

  it('blocks before creating a thread record or a run', async () => {
    blockedQuota();
    const memoryCalls: string[] = [];
    const agentWithMemory = {
      stream: runnableAgent.stream,
      getMemory: async () => ({
        getThreadById: async () => {
          memoryCalls.push('getThreadById');
          return null;
        },
        createThread: async () => {
          memoryCalls.push('createThread');
          return {};
        },
      }),
    };
    const res = await startHandler(
      makeContext({
        body: { ...VALID },
        mastra: { getAgentById: () => agentWithMemory },
      }) as never,
    );
    expect(res.status).toBe(429);
    expect(memoryCalls).toEqual([]); // ensureFirstTurnThread never ran
    expect(registryState.registry.findActiveRun(
      'main-agent',
      'main-agent-user-1-uuid-a',
      'user-1',
    )).toBeNull();
  });

  it('still returns 404 for an unknown agent when the quota is exhausted', async () => {
    blockedQuota();
    const res = await startHandler(
      makeContext({
        body: { ...VALID },
        mastra: { getAgentById: () => undefined },
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  it('starts normally while under the quota', async () => {
    const res = await startHandler(
      makeContext({ body: { ...VALID }, mastra: mastraWithAgent() }) as never,
    );
    expect(res.status).toBe(202);
  });
});
