import {
  type AgentRunEventType,
  type RunRegistry,
} from './run-registry.js';

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

export interface RunnableAgent {
  stream(
    prompt: string,
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
    title?: string;
  }): Promise<unknown>;
}

const MAX_ERROR_TEXT_BYTES = 500;

function sanitizeErrorText(error: unknown): string {
  const text =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return text.slice(0, MAX_ERROR_TEXT_BYTES);
}

function chunkPayload(chunk: StreamChunk): Record<string, unknown> {
  return chunk.payload && typeof chunk.payload === 'object'
    ? (chunk.payload as Record<string, unknown>)
    : {};
}

/** Maps a Mastra stream chunk to a registry event, or null to ignore it. */
export function chunkToRunEvent(
  chunk: StreamChunk,
):
  | { type: AgentRunEventType; payload: Record<string, unknown> }
  | null {
  if (typeof chunk.type !== 'string') return null;

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
    case 'error': {
      const payload = chunkPayload(chunk);
      return {
        type: 'error',
        payload: { error: sanitizeErrorText(payload.error) },
      };
    }
    default:
      return null;
  }
}

export function buildThreadTitle(prompt: string): string {
  return prompt.length > 52
    ? `${prompt.slice(0, 49).trim()}…`
    : prompt;
}

/**
 * Creates the Memory thread record for a first turn before execution starts,
 * titled from the prompt. Mastra's stream would create the thread record on
 * its own once consumption begins, but doing it here (before the 202 goes
 * out) means the thread and its name are already visible to thread listings
 * the moment the client is told the run started. Best-effort: on failure,
 * Mastra's own thread creation during the run still applies.
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
      title: buildThreadTitle(params.prompt),
    });
  } catch {
    // Title creation is best-effort; the run itself must still start.
  }
}

export interface RunExecutionParams {
  runId: string;
  agentId: string;
  threadId: string;
  resourceId: string;
  prompt: string;
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
): Promise<void> {
  let sawError = false;

  try {
    const output = await agent.stream(params.prompt, {
      memory: { thread: params.threadId, resource: params.resourceId },
      runId: params.runId,
      abortSignal: params.abortSignal,
    });

    const reader = output.fullStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const mapped = chunkToRunEvent(value ?? {});
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
