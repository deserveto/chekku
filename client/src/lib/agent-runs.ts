/**
 * Client for the server-owned agent-run surface (`/api/runs/*`).
 *
 * Starting a run and observing a run are distinct operations: `startRun`
 * returns immediately with a run id, and `observeRunEvents` attaches to
 * the run's event stream with replay-from-offset, so navigating away,
 * reloading, or reconnecting never restarts execution.
 */

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentRunEventType =
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'tool-error'
  | 'finish'
  | 'error'
  | 'cancelled';

export interface AgentRunSummary {
  id: string;
  resourceId: string;
  agentId: string;
  threadId: string;
  /**
   * The prompt that started the run. Mastra persists the user message only
   * at turn end, so a client attaching to an in-flight run renders the
   * user turn from this field instead of Memory.
   */
  prompt: string;
  status: AgentRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  evicted?: boolean;
}

export interface AgentRunEvent {
  sequence: number;
  type: AgentRunEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class RunConflictError extends Error {
  readonly run: AgentRunSummary | undefined;

  constructor(run: AgentRunSummary | undefined, message: string) {
    super(message);
    this.name = 'RunConflictError';
    this.run = run;
  }
}

const RUN_EVENT_TYPES = new Set<AgentRunEventType>([
  'text-delta',
  'tool-call',
  'tool-result',
  'tool-error',
  'finish',
  'error',
  'cancelled',
]);

export function isTerminalRunEvent(event: AgentRunEvent): boolean {
  return (
    event.type === 'finish' || event.type === 'error' || event.type === 'cancelled'
  );
}

async function readErrorResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Fall through to the generic message.
  }
  return `Request failed (${response.status})`;
}

export async function startRun(params: {
  agentId: string;
  threadId: string;
  prompt: string;
}): Promise<AgentRunSummary> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: params.agentId,
      threadId: params.threadId,
      prompt: params.prompt,
    }),
  });

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      run?: AgentRunSummary;
      error?: unknown;
    };
    throw new RunConflictError(
      body.run,
      typeof body.error === 'string' ? body.error : 'A run is already active',
    );
  }
  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  const body = (await response.json()) as { run?: AgentRunSummary };
  if (!body.run) throw new Error('Run start response missing run');
  return body.run;
}

export async function getActiveRun(
  agentId: string,
  threadId: string,
): Promise<AgentRunSummary | null> {
  const search = new URLSearchParams({ agentId, threadId });
  const response = await fetch(`/api/runs/active?${search.toString()}`);
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }
  const body = (await response.json()) as { run?: AgentRunSummary };
  return body.run ?? null;
}

export async function listActiveRuns(
  agentId?: string,
): Promise<AgentRunSummary[]> {
  const search = new URLSearchParams();
  if (agentId) search.set('agentId', agentId);
  const query = search.toString();
  const response = await fetch(`/api/runs/list${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }
  const body = (await response.json()) as { runs?: AgentRunSummary[] };
  return Array.isArray(body.runs) ? body.runs : [];
}

export async function cancelRun(runId: string): Promise<AgentRunSummary> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }
  const body = (await response.json()) as { run?: AgentRunSummary };
  if (!body.run) throw new Error('Cancel response missing run');
  return body.run;
}

/**
 * Incremental SSE parser: feed decoded text chunks, receive complete
 * `data:`-carried JSON events. Comment lines (heartbeats) are ignored.
 */
export class RunEventStreamParser {
  private buffer = '';

  push(text: string): AgentRunEvent[] {
    this.buffer += text;
    const events: AgentRunEvent[] = [];

    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) events.push(event);
      boundary = this.buffer.indexOf('\n\n');
    }

    return events;
  }
}

function parseSseBlock(block: string): AgentRunEvent | null {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const sequence = record.sequence;
  const type = record.type;
  if (
    typeof sequence !== 'number' ||
    !Number.isInteger(sequence) ||
    typeof type !== 'string' ||
    !RUN_EVENT_TYPES.has(type as AgentRunEventType)
  ) {
    return null;
  }

  return {
    sequence,
    type: type as AgentRunEventType,
    payload:
      record.payload && typeof record.payload === 'object'
        ? (record.payload as Record<string, unknown>)
        : {},
    createdAt:
      typeof record.createdAt === 'string' ? record.createdAt : '',
  };
}

const MAX_RECONNECT_DELAY_MS = 8_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface ObserveRunOptions {
  offset?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentRunEvent) => void;
}

/**
 * Observes a run until it reaches a terminal event (or the run record is
 * evicted). Transparently reconnects with `offset = lastSequence + 1`
 * when the stream drops mid-run, so events are delivered exactly once.
 */
export async function observeRunEvents(
  runId: string,
  options: ObserveRunOptions,
): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  let cursor = options.offset ?? 0;
  let attempt = 0;

  while (!signal.aborted) {
    let terminalReached = false;

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events?offset=${cursor}`,
        { signal, headers: { Accept: 'text/event-stream' } },
      );
      if (response.status === 404) return;
      if (!response.ok || !response.body) {
        throw new Error(`Run event stream failed (${response.status})`);
      }

      const parser = new RunEventStreamParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const deliver = (events: AgentRunEvent[]): void => {
        for (const event of events) {
          cursor = Math.max(cursor, event.sequence + 1);
          options.onEvent(event);
          if (isTerminalRunEvent(event)) terminalReached = true;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // `{ stream: true }` keeps multi-byte characters intact when a
        // network chunk boundary splits their UTF-8 bytes; without it each
        // half decodes to U+FFFD and corrupts the accumulated message.
        deliver(parser.push(decoder.decode(value, { stream: true })));
      }
      // Flush any trailing bytes the streaming decoder still holds.
      deliver(parser.push(decoder.decode()));
    } catch {
      if (signal.aborted) return;
    }

    if (terminalReached) return;

    const delay = Math.min(1_000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    attempt += 1;
    await abortableSleep(delay, signal);
    if (signal.aborted) return;
  }
}
