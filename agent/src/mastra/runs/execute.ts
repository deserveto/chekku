import {
  type AgentRunEventType,
  type RunRegistry,
} from './run-registry.js';
import {
  RunUsageTracker,
  type TokenQuotaConsumer,
} from './token-quota.js';
import { TASK_TOOL_NAMES } from '../tasks/task-signals.js';
import { extractTaskSnapshot } from '../tasks/task-stream-adapter.js';

/**
 * Server-side execution driver for one agent run.
 *
 * The stream is consumed by the agent server process itself with a
 * server-owned AbortController, so the run's lifetime is independent of
 * every HTTP connection: the browser start request, the SSE subscribers,
 * and any React component can come and go without cancelling execution.
 */

type StreamChunk = {
  type?: unknown;
  payload?: unknown;
};

export type RunUserContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType: string; filename?: string }
>;

export type RunStreamInput =
  | string
  | Array<{ role: 'user'; content: RunUserContent }>;

export interface RunnableAgent {
  stream(
    prompt: RunStreamInput,
    options: {
      memory: { thread: string; resource: string };
      runId: string;
      abortSignal: AbortSignal;
    },
  ): Promise<{ fullStream: ReadableStream<StreamChunk> }>;
  getMemory(): Promise<MemoryAccess | undefined>;
}

export interface MemoryAccess {
  getThreadById(params: { threadId: string }): Promise<
    | {
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined
  >;
  createThread(params: {
    threadId: string;
    resourceId: string;
  }): Promise<unknown>;
}

const MAX_ERROR_TEXT_CHARS = 500;

function sanitizeErrorText(error: unknown): string {
  let text: string;
  if (typeof error === 'string') text = error;
  else if (error instanceof Error) text = error.message;
  else if (typeof error === 'number' || typeof error === 'bigint') {
    text = String(error);
  } else {
    // Objects, symbols, null, undefined: coercing with String() would
    // surface "[object Object]" in run events.
    text = '';
  }
  const source = text || 'Unknown error';
  // Truncate on Unicode code points, not UTF-16 code units: slicing a
  // surrogate pair in half would end the error in a lone surrogate
  // (same rule as buildThreadTitle below).
  const characters = Array.from(source);
  return characters.length <= MAX_ERROR_TEXT_CHARS
    ? source
    : characters.slice(0, MAX_ERROR_TEXT_CHARS).join('');
}

function chunkPayload(chunk: StreamChunk): Record<string, unknown> {
  return chunk.payload && typeof chunk.payload === 'object'
    ? (chunk.payload as Record<string, unknown>)
    : {};
}

function isTaskToolChunk(chunk: StreamChunk): boolean {
  const toolName = chunkPayload(chunk).toolName;
  return typeof toolName === 'string' && TASK_TOOL_NAMES.has(toolName);
}

/** Maps a Mastra stream chunk to a registry event, or null to ignore it. */
export function chunkToRunEvent(
  chunk: StreamChunk,
):
  | { type: AgentRunEventType; payload: Record<string, unknown> }
  | null {
  if (typeof chunk.type !== 'string') return null;

  // Task tools are the transport for the dedicated Tasks UI, not chat
  // timeline activity: their calls are suppressed, successful results
  // surface as one authoritative `task-list` snapshot, and failures pass
  // through as bounded `tool-error` events (the client routes them to a
  // dock notice, never a timeline card) so a failed task call is not
  // invisible.
  if (
    (chunk.type === 'tool-call' ||
      chunk.type === 'tool-result' ||
      chunk.type === 'tool-error') &&
    isTaskToolChunk(chunk)
  ) {
    const payload = chunkPayload(chunk);
    const tasks = extractTaskSnapshot(chunk);
    if (tasks) return { type: 'task-list', payload: { tasks } };

    // Task tools also report semantic failures (no memory, validation)
    // inside their result object instead of throwing.
    const result = payload.result;
    const resultIsError =
      !!result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).isError === true
        : false;
    const failed =
      chunk.type === 'tool-error' || payload.isError === true || resultIsError;
    if (failed && typeof payload.toolCallId === 'string') {
      return {
        type: 'tool-error',
        payload: {
          toolCallId: payload.toolCallId,
          toolName: String(payload.toolName ?? 'task'),
          // Only string-shaped detail feeds the notice; a raw result
          // object would stringify to "[object Object]" downstream.
          error: sanitizeErrorText(
            payload.error ??
              (typeof result === 'string' ? result : undefined) ??
              (result &&
              typeof result === 'object' &&
              typeof (result as Record<string, unknown>).content === 'string'
                ? ((result as Record<string, unknown>).content as string)
                : undefined),
          ),
        },
      };
    }
    return null;
  }

  switch (chunk.type) {
    case 'text-delta': {
      const payload = chunkPayload(chunk);
      if (typeof payload.text !== 'string' || !payload.text) return null;
      return { type: 'text-delta', payload: { text: payload.text } };
    }
    case 'tool-call': {
      const payload = chunkPayload(chunk);
      if (typeof payload.toolCallId !== 'string') return null;
      return {
        type: 'tool-call',
        payload: {
          toolCallId: payload.toolCallId,
          toolName: String(payload.toolName ?? 'tool'),
          args: payload.args,
        },
      };
    }
    case 'tool-result': {
      const payload = chunkPayload(chunk);
      if (typeof payload.toolCallId !== 'string') return null;
      const isError = payload.isError === true;
      return {
        type: isError ? 'tool-error' : 'tool-result',
        payload: {
          toolCallId: payload.toolCallId,
          toolName: String(payload.toolName ?? 'tool'),
          ...(isError
            ? { error: payload.result ?? payload.error }
            : { result: payload.result }),
        },
      };
    }
    // @mastra/core emits tool failures as a distinct `tool-error` chunk
    // (ToolErrorPayload), not only as `tool-result` with `isError: true`.
    // Without this case the chunk falls through to `default` and the
    // client's tool card stays stuck on "running".
    case 'tool-error': {
      const payload = chunkPayload(chunk);
      if (typeof payload.toolCallId !== 'string') return null;
      return {
        type: 'tool-error',
        payload: {
          toolCallId: payload.toolCallId,
          toolName: String(payload.toolName ?? 'tool'),
          error: payload.error ?? payload.result,
        },
      };
    }
    case 'error': {
      const payload = chunkPayload(chunk);
      return {
        type: 'error',
        payload: { error: sanitizeErrorText(payload.error) },
      };
    }
    case 'tripwire': {
      const payload = chunkPayload(chunk);
      const reason =
        typeof payload.reason === 'string' && payload.reason.trim()
          ? payload.reason
          : 'The request exceeded a processing limit.';
      return {
        type: 'error',
        payload: {
          error: sanitizeErrorText(
            `Request stopped by a safety limit. ${reason}`,
          ),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Creates the Memory thread record for a first turn before execution starts,
 * untitled. The record must exist before the 202 goes out so the thread is
 * listed the moment the client is told the run started, but the title stays
 * empty on purpose: Mastra's native title generation (generateTitle on the
 * agent's Memory) fires at first-turn completion only while the thread has no
 * title, and a pre-set truncated prompt title would suppress it. The client
 * renders its 'New conversation' fallback until the generated title lands.
 * Best-effort: on failure, Mastra's own thread creation during the run still
 * applies.
 */
export async function ensureFirstTurnThread(
  agent: RunnableAgent,
  params: { threadId: string; resourceId: string; prompt: string },
): Promise<void> {
  try {
    const memory = await agent.getMemory();
    if (!memory) return;
    const thread = await memory.getThreadById({ threadId: params.threadId });
    if (thread) return;
    await memory.createThread({
      threadId: params.threadId,
      resourceId: params.resourceId,
    });
  } catch {
    // Thread creation is best-effort; the run itself must still start.
  }
}

export interface RunExecutionParams {
  runId: string;
  agentId: string;
  threadId: string;
  resourceId: string;
  prompt: string;
  /** Optional multimodal message content; kept transient and never copied into the run registry. */
  content?: RunUserContent;
  /** Signal owned by the route handler; `registry.createRun` received its abort callback. */
  abortSignal: AbortSignal;
}

/**
 * Consumes the agent stream into the registry and finalizes the run.
 * `registry.createRun` must already have succeeded (the route handler
 * calls it synchronously so duplicate starts get a 409 before any
 * execution begins). Never throws: failures become terminal run state.
 */
export async function runExecution(
  registry: RunRegistry,
  agent: RunnableAgent,
  params: RunExecutionParams,
  quota?: TokenQuotaConsumer,
): Promise<void> {
  let sawError = false;
  const usageTracker = new RunUsageTracker((tokens) =>
    quota?.consume(params.resourceId, tokens),
  );

  try {
    const streamInput: RunStreamInput = params.content
      ? [{ role: 'user', content: params.content }]
      : params.prompt;
    const output = await agent.stream(streamInput, {
      memory: { thread: params.threadId, resource: params.resourceId },
      runId: params.runId,
      abortSignal: params.abortSignal,
    });

    const reader = output.fullStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value ?? {};
      // Usage chunks feed the token quota only; they never become run
      // events, so the client stream is unchanged.
      if (chunk.type === 'step-finish') {
        usageTracker.recordStepFinish(chunkPayload(chunk));
      } else if (chunk.type === 'finish') {
        usageTracker.recordFinish(chunkPayload(chunk));
      }
      const mapped = chunkToRunEvent(chunk);
      if (mapped) {
        if (mapped.type === 'error') sawError = true;
        registry.appendEvent(params.runId, mapped.type, mapped.payload);
      }
    }

    const cancelled = registry.isCancelRequested(params.runId);
    if (cancelled) {
      registry.finishRun(params.runId, 'cancelled');
      return;
    }

    registry.finishRun(
      params.runId,
      sawError ? 'failed' : 'completed',
      sawError ? 'The agent run reported an error.' : undefined,
    );
  } catch (error) {
    if (registry.isCancelRequested(params.runId)) {
      registry.finishRun(params.runId, 'cancelled');
    } else {
      registry.finishRun(params.runId, 'failed', sanitizeErrorText(error));
    }
  }
}
