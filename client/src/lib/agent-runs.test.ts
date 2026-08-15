import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunConflictError,
  RunEventStreamParser,
  cancelRun,
  getActiveRun,
  isTerminalRunEvent,
  listActiveRuns,
  observeRunEvents,
  startRun,
  type AgentRunEvent,
} from './agent-runs';

const run = {
  id: 'run_20260101000000_00000001',
  resourceId: 'user-1',
  agentId: 'main-agent',
  threadId: 'main-agent-user-1-uuid-a',
  status: 'running' as const,
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const block of blocks) controller.enqueue(encoder.encode(block));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RunEventStreamParser', () => {
  it('parses data blocks and ignores heartbeat comments', () => {
    const parser = new RunEventStreamParser();
    const events = parser.push(
      ': ping\n\n' +
        `data: ${JSON.stringify({
          sequence: 0,
          type: 'text-delta',
          payload: { text: 'hi' },
          createdAt: '',
        })}\n\n`,
    );

    expect(events).toEqual([
      {
        sequence: 0,
        type: 'text-delta',
        payload: { text: 'hi' },
        createdAt: '',
      },
    ]);
  });

  it('reassembles events split across pushes', () => {
    const parser = new RunEventStreamParser();
    const raw = `data: ${JSON.stringify({
      sequence: 1,
      type: 'finish',
      payload: {},
      createdAt: '',
    })}\n\n`;

    expect(parser.push(raw.slice(0, 10))).toEqual([]);
    const events = parser.push(raw.slice(10));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('finish');
  });

  it('drops malformed and unknown events', () => {
    const parser = new RunEventStreamParser();
    const events = parser.push(
      'data: not-json\n\ndata: 42\n\ndata: {"sequence":0,"type":"bogus","payload":{}}\n\n',
    );
    expect(events).toEqual([]);
  });
});

describe('isTerminalRunEvent', () => {
  it('marks finish, error, and cancelled as terminal', () => {
    for (const type of ['finish', 'error', 'cancelled'] as const) {
      expect(
        isTerminalRunEvent({
          sequence: 0,
          type,
          payload: {},
          createdAt: '',
        }),
      ).toBe(true);
    }
    expect(
      isTerminalRunEvent({
        sequence: 0,
        type: 'text-delta',
        payload: {},
        createdAt: '',
      }),
    ).toBe(false);
  });
});

describe('startRun', () => {
  it('posts the prompt and returns the run summary', async () => {
    const result = await startRun({
      agentId: 'main-agent',
      threadId: run.threadId,
      prompt: 'hello',
    });

    expect(result.id).toBe(run.id);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      agentId: 'main-agent',
      threadId: run.threadId,
      prompt: 'hello',
    });
  });

  it('surfaces a conflict with the existing run for 409 responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run, error: 'busy' }, 409));

    const error = await startRun({
      agentId: 'main-agent',
      threadId: run.threadId,
      prompt: 'hello',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RunConflictError);
    expect((error as RunConflictError).run?.id).toBe(run.id);
    expect((error as RunConflictError).message).toBe('busy');
  });

  it('surfaces server error messages', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Unknown agent' }, 404),
    );

    await expect(
      startRun({
        agentId: 'main-agent',
        threadId: run.threadId,
        prompt: 'hello',
      }),
    ).rejects.toThrow('Unknown agent');
  });
});

describe('getActiveRun', () => {
  it('returns null for 204 responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await getActiveRun('main-agent', run.threadId)).toBeNull();
  });

  it('returns the run for 200 responses', async () => {
    const result = await getActiveRun('main-agent', run.threadId);
    expect(result?.id).toBe(run.id);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/runs/active?');
    expect(String(url)).toContain(`threadId=${run.threadId}`);
  });
});

describe('listActiveRuns', () => {
  it('returns the runs array and forwards the agent filter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runs: [run] }));

    const runs = await listActiveRuns('main-agent');

    expect(runs).toEqual([run]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/runs/list?agentId=main-agent`,
    );
  });
});

describe('cancelRun', () => {
  it('posts to the cancel endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ run: { ...run, status: 'cancelled' } }),
    );

    const result = await cancelRun(run.id);

    expect(result.status).toBe('cancelled');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`/api/runs/${run.id}/cancel`);
    expect(init.method).toBe('POST');
  });
});

describe('observeRunEvents', () => {
  function event(sequence: number, type: string): AgentRunEvent {
    return {
      sequence,
      type: type as AgentRunEvent['type'],
      payload: {},
      createdAt: '',
    };
  }

  it('resolves after the terminal event without reconnecting', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify(event(0, 'text-delta'))}\n\n`,
        `data: ${JSON.stringify(event(1, 'finish'))}\n\n`,
      ]),
    );

    const seen: string[] = [];
    await observeRunEvents(run.id, {
      onEvent: (e) => seen.push(e.type),
    });

    expect(seen).toEqual(['text-delta', 'finish']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects from the last sequence when the stream drops mid-run', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([`data: ${JSON.stringify(event(0, 'text-delta'))}\n\n`]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify(event(1, 'tool-call'))}\n\n`,
          `data: ${JSON.stringify(event(2, 'finish'))}\n\n`,
        ]),
      );

    const seen: number[] = [];
    await observeRunEvents(run.id, {
      onEvent: (e) => seen.push(e.sequence),
    });

    expect(seen).toEqual([0, 1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain('offset=1');
  });

  it('stops without reconnecting when aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await observeRunEvents(run.id, {
      signal: controller.signal,
      onEvent: () => undefined,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
