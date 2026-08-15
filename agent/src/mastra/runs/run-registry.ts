/**
 * In-memory registry of server-owned agent runs.
 *
 * A run's lifetime is the agent server process: execution is driven by a
 * server-owned AbortController, never by an HTTP connection, so navigating
 * away or reloading the browser never cancels a run. Because a server
 * restart kills both the execution and this registry together, no durable
 * run storage exists — persisted conversation state remains Mastra Memory.
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

export interface AgentRunEvent {
  sequence: number;
  type: AgentRunEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunSummary {
  id: string;
  resourceId: string;
  agentId: string;
  threadId: string;
  /**
   * The prompt that started the run. Mastra persists the user message only
   * at turn end, so reconnecting clients need it from the run record to
   * render the in-flight user turn.
   */
  prompt: string;
  status: AgentRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  evicted?: boolean;
}

export const RUN_ID_PATTERN = /^run_[0-9]{14}_[0-9a-f]{8}$/;

export const RUN_TERMINAL_EVENT_TYPES: readonly AgentRunEventType[] = [
  'finish',
  'error',
  'cancelled',
];

export class RunConflictError extends Error {
  readonly run: AgentRunSummary;

  constructor(run: AgentRunSummary) {
    super('A run is already active for this thread');
    this.name = 'RunConflictError';
    this.run = run;
  }
}

interface AgentRunRecord {
  summary: AgentRunSummary;
  events: AgentRunEvent[];
  nextSequence: number;
  bufferBytes: number;
  cancelRequested: boolean;
  requestAbort: () => void;
  listeners: Set<(event: AgentRunEvent) => void>;
}

export interface RunRegistryOptions {
  now?: () => number;
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxEventBufferBytes?: number;
  terminalTtlMs?: number;
}

const DEFAULTS = {
  maxRuns: 200,
  maxEventsPerRun: 10_000,
  maxEventBufferBytes: 4 * 1024 * 1024,
  terminalTtlMs: 30 * 60 * 1000,
};

function approximateEventBytes(event: AgentRunEvent): number {
  let payloadSize = 64;
  try {
    payloadSize = JSON.stringify(event.payload)?.length ?? payloadSize;
  } catch {
    // Non-serializable payloads still count against the floor size.
  }
  return payloadSize + 128;
}

export function createRunId(
  now: () => number = Date.now,
  random: () => string = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
): string {
  const timestamp = new Date(now())
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  return `run_${timestamp}_${random()}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export class RunRegistry {
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly now: () => number;
  private readonly maxRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly maxEventBufferBytes: number;
  private readonly terminalTtlMs: number;

  constructor(options: RunRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxRuns = options.maxRuns ?? DEFAULTS.maxRuns;
    this.maxEventsPerRun = options.maxEventsPerRun ?? DEFAULTS.maxEventsPerRun;
    this.maxEventBufferBytes =
      options.maxEventBufferBytes ?? DEFAULTS.maxEventBufferBytes;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULTS.terminalTtlMs;
  }

  /**
   * Registers a run and reserves the single non-terminal slot for
   * `(agentId, threadId, resourceId)`. Throws `RunConflictError` while
   * another run on the same tuple is still non-terminal.
   */
  createRun(params: {
    id: string;
    agentId: string;
    threadId: string;
    resourceId: string;
    prompt: string;
    requestAbort: () => void;
  }): AgentRunSummary {
    if (!isRunId(params.id)) {
      throw new Error('Invalid run id');
    }

    this.evictExpired();

    const existing = this.findActiveRun(
      params.agentId,
      params.threadId,
      params.resourceId,
    );
    if (existing) {
      throw new RunConflictError(existing);
    }

    const startedAt = new Date(this.now()).toISOString();
    const record: AgentRunRecord = {
      summary: {
        id: params.id,
        resourceId: params.resourceId,
        agentId: params.agentId,
        threadId: params.threadId,
        prompt: params.prompt,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
      },
      events: [],
      nextSequence: 0,
      bufferBytes: 0,
      cancelRequested: false,
      requestAbort: params.requestAbort,
      listeners: new Set(),
    };

    this.records.set(params.id, record);
    this.evictOverflow();
    return { ...record.summary };
  }

  getRun(runId: string): AgentRunSummary | null {
    this.evictExpired();
    const record = this.records.get(runId);
    return record ? { ...record.summary } : null;
  }

  findActiveRun(
    agentId: string,
    threadId: string,
    resourceId: string,
  ): AgentRunSummary | null {
    this.evictExpired();
    for (const record of this.records.values()) {
      if (
        record.summary.status === 'running' &&
        record.summary.agentId === agentId &&
        record.summary.threadId === threadId &&
        record.summary.resourceId === resourceId
      ) {
        return { ...record.summary };
      }
    }
    return null;
  }

  listActiveRuns(resourceId: string, agentId?: string): AgentRunSummary[] {
    this.evictExpired();
    const runs: AgentRunSummary[] = [];
    for (const record of this.records.values()) {
      const { summary } = record;
      if (summary.status !== 'running') continue;
      if (summary.resourceId !== resourceId) continue;
      if (agentId && summary.agentId !== agentId) continue;
      runs.push({ ...summary });
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  isCancelRequested(runId: string): boolean {
    return this.records.get(runId)?.cancelRequested ?? false;
  }

  /** Appends one event. Ignored for unknown or already-terminal runs. */
  appendEvent(
    runId: string,
    type: AgentRunEventType,
    payload: Record<string, unknown>,
  ): AgentRunEvent | null {
    const record = this.records.get(runId);
    if (!record || record.summary.status !== 'running') return null;

    const event: AgentRunEvent = {
      sequence: record.nextSequence++,
      type,
      payload,
      createdAt: new Date(this.now()).toISOString(),
    };
    record.events.push(event);
    record.bufferBytes += approximateEventBytes(event);
    record.summary.updatedAt = event.createdAt;

    while (
      record.events.length > 1 &&
      (record.events.length > this.maxEventsPerRun ||
        record.bufferBytes > this.maxEventBufferBytes)
    ) {
      const dropped = record.events.shift();
      record.bufferBytes -= dropped ? approximateEventBytes(dropped) : 0;
      record.summary.evicted = true;
    }

    for (const listener of record.listeners) {
      listener(event);
    }
    return { ...event };
  }

  /**
   * Moves a run to a terminal status and appends the matching terminal
   * event. Safe to call again (first call wins) so racing cancel/finish
   * paths stay deterministic.
   */
  finishRun(
    runId: string,
    status: Exclude<AgentRunStatus, 'running'>,
    error?: string,
  ): AgentRunSummary | null {
    const record = this.records.get(runId);
    if (!record || record.summary.status !== 'running') {
      return record ? { ...record.summary } : null;
    }

    const terminalType: AgentRunEventType =
      status === 'completed'
        ? 'finish'
        : status === 'cancelled'
          ? 'cancelled'
          : 'error';
    // appendEvent notifies subscribers while the record is still
    // non-terminal, so the terminal event is delivered exactly once.
    this.appendEvent(runId, terminalType, error ? { error } : {});

    record.summary.status = status;
    record.summary.completedAt = new Date(this.now()).toISOString();
    record.summary.updatedAt = record.summary.completedAt;
    if (error) record.summary.error = error;
    record.listeners.clear();
    return { ...record.summary };
  }

  /**
   * Requests cancellation of a run: latches the intent, aborts the run's
   * execution signal, and lets the execution loop finalize the status.
   * Terminal runs are returned unchanged (idempotent).
   */
  requestCancel(runId: string): AgentRunSummary | null {
    this.evictExpired();
    const record = this.records.get(runId);
    if (!record) return null;
    if (record.summary.status === 'running' && !record.cancelRequested) {
      record.cancelRequested = true;
      record.requestAbort();
    }
    return { ...record.summary };
  }

  /**
   * Atomically replays buffered events with `sequence >= offset` and then
   * streams live events. If events were evicted below the requested
   * offset, replay simply starts at the oldest surviving event.
   */
  subscribeFrom(
    runId: string,
    offset: number,
    onEvent: (event: AgentRunEvent) => void,
  ): { unsubscribe: () => void } | null {
    this.evictExpired();
    const record = this.records.get(runId);
    if (!record) return null;

    for (const event of record.events) {
      if (event.sequence >= offset) onEvent(event);
    }

    if (record.summary.status !== 'running') {
      return { unsubscribe: () => undefined };
    }

    const listener = (event: AgentRunEvent) => onEvent(event);
    record.listeners.add(listener);
    return {
      unsubscribe: () => {
        record.listeners.delete(listener);
      },
    };
  }

  private evictExpired(): void {
    const nowMs = this.now();
    for (const [id, record] of this.records) {
      const { summary } = record;
      if (
        summary.status !== 'running' &&
        summary.completedAt &&
        Date.parse(summary.completedAt) + this.terminalTtlMs <= nowMs
      ) {
        this.records.delete(id);
      }
    }
  }

  private evictOverflow(): void {
    if (this.records.size <= this.maxRuns) return;
    const terminalIds = [...this.records.entries()]
      .filter(([, record]) => record.summary.status !== 'running')
      .sort(
        (a, b) =>
          Date.parse(a[1].summary.completedAt ?? a[1].summary.startedAt) -
          Date.parse(b[1].summary.completedAt ?? b[1].summary.startedAt),
      );
    for (const [id] of terminalIds) {
      if (this.records.size <= this.maxRuns) break;
      this.records.delete(id);
    }
  }
}

export const agentRunRegistry = new RunRegistry();
