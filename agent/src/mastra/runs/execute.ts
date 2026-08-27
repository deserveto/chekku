import {
  type AgentRunEvent,
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
  ): Promise<StreamResult>;
  getMemory(): Promise<MemoryAccess | undefined>;
}

export interface StreamResult {
  fullStream: ReadableStream<StreamChunk>;
  /**
   * Present when the agent runs through durable execution
   * (`createDurableAgent`): releases the durable run's PubSub subscription
   * and engine registry entry. Called by the driver once the run is
   * terminal — regular agents leave it undefined.
   */
  cleanup?: () => void;
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
  /**
   * Inserts (or upserts) reconstructed messages into the thread. This is
   * deliberately `saveMessages`, not `updateMessages`: a cancelled turn has
   * new message IDs, so an update-only call silently leaves it absent.
   */
  saveMessages?(params: { messages: unknown[] }): Promise<unknown>;
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

export function buildThreadTitle(prompt: string): string {
  // Truncate on Unicode code points, not UTF-16 code units: slicing a
  // surrogate pair in half would end the title in a lone surrogate.
  const characters = Array.from(prompt);
  if (characters.length <= 52) return prompt;
  return `${characters.slice(0, 49).join('').trim()}…`;
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
  /** Optional multimodal message content; kept transient and never copied into the run registry. */
  content?: RunUserContent;
  /** Signal owned by the route handler; `registry.createRun` received its abort callback. */
  abortSignal: AbortSignal;
}

/**
 * Bounds for the reconstructed cancelled turn. Tool outputs (Reader Markdown
 * can reach ~70 KB per page) are capped per call and in total so the
 * persisted partial turn stays cheap to store and to recall on later turns.
 */
const MAX_CANCELLED_TOOL_RESULT_CHARS = 6_000;
const MAX_CANCELLED_ASSISTANT_CHARS = 48_000;
const CANCELLED_MARKER =
  '_[Run dihentikan oleh pengguna — konteks parsial disimpan agar analisis bisa dilanjutkan di thread ini.]_';
const CANCELLED_TOOL_RESULT_TEXT =
  'Tool call was interrupted before completing (run stopped by the user).';

function boundedString(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? 'null';
    } catch {
      text = String(value);
    }
  }
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…[truncated]`;
  return text;
}

/** One persisted message of the reconstructed cancelled turn. */
export interface CancelledTurnMessage {
  id: string;
  role: 'user' | 'assistant';
  createdAt: Date;
  threadId: string;
  resourceId: string;
  content: { format: 2; parts: unknown[] };
}

/**
 * Reconstructs the cancelled turn from the run record: the starting prompt
 * (user message) plus the assistant partial — tool calls with their results
 * (or a synthetic interrupted result, which the next provider request
 * requires: a tool-call without any tool-result is rejected by
 * OpenAI-compatible gateways) and the streamed text so far.
 *
 * Mastra itself skips persistence for an aborted turn, so without this
 * bridge a stopped run leaves the thread blank and a later "lanjutkan"
 * starts from zero context.
 */
export function buildCancelledTurnMessages(
  params: {
    runId: string;
    threadId: string;
    resourceId: string;
    prompt: string;
    content?: RunUserContent;
  },
  events: readonly AgentRunEvent[],
): [CancelledTurnMessage, CancelledTurnMessage] {
  const userParts: Array<Record<string, unknown>> = [];
  if (params.content && params.content.length > 0) {
    for (const part of params.content) {
      if (part.type === 'text') {
        userParts.push({ type: 'text', text: part.text });
      } else {
        userParts.push({
          type: 'text',
          text: `[lampiran gambar ${part.filename ?? 'tanpa nama'} tidak disimpan ketika run dihentikan]`,
        });
      }
    }
  } else {
    userParts.push({ type: 'text', text: params.prompt });
  }

  const assistantParts: Array<Record<string, unknown>> = [];
  let streamedText = '';
  let totalChars = 0;
  const resolvedToolCalls = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'text-delta': {
        const text = typeof event.payload.text === 'string' ? event.payload.text : '';
        streamedText += text;
        break;
      }
      case 'tool-call': {
        assistantParts.push({
          type: 'tool-call',
          toolCallId: String(event.payload.toolCallId ?? ''),
          toolName: String(event.payload.toolName ?? 'tool'),
          ...(event.payload.args !== undefined ? { input: event.payload.args } : {}),
        });
        break;
      }
      case 'tool-result': {
        resolvedToolCalls.add(String(event.payload.toolCallId ?? ''));
        const value = event.payload.result;
        const serialized = boundedString(value, MAX_CANCELLED_TOOL_RESULT_CHARS);
        totalChars += serialized.length;
        assistantParts.push({
          type: 'tool-result',
          toolCallId: String(event.payload.toolCallId ?? ''),
          toolName: String(event.payload.toolName ?? 'tool'),
          output:
            totalChars > MAX_CANCELLED_ASSISTANT_CHARS
              ? { type: 'text', value: '[content omitted to bound the persisted partial turn]' }
              : value !== undefined && serialized.length <= MAX_CANCELLED_TOOL_RESULT_CHARS
                ? value
                : serialized,
        });
        break;
      }
      case 'tool-error': {
        resolvedToolCalls.add(String(event.payload.toolCallId ?? ''));
        assistantParts.push({
          type: 'tool-result',
          toolCallId: String(event.payload.toolCallId ?? ''),
          toolName: String(event.payload.toolName ?? 'tool'),
          output: {
            type: 'error-text',
            value: boundedString(event.payload.error, MAX_CANCELLED_TOOL_RESULT_CHARS),
          },
        });
        break;
      }
      default:
        break;
    }
  }

  // Pair every tool-call with a tool-result: the next provider request in
  // this thread is rejected if a tool-call has no matching tool-result.
  // Synthetic results carry `interrupted: true` so the restore path can
  // distinguish a stopped tool from a genuinely failed one (the
  // `error-text` output alone would render the card as an error).
  for (const part of assistantParts) {
    if (part.type !== 'tool-call') continue;
    const toolCallId = part.toolCallId;
    if (resolvedToolCalls.has(String(toolCallId))) continue;
    assistantParts.push({
      type: 'tool-result',
      toolCallId,
      toolName: part.toolName,
      output: { type: 'error-text', value: CANCELLED_TOOL_RESULT_TEXT },
      interrupted: true,
    });
  }

  const assistantText = streamedText
    ? `${streamedText}\n\n${CANCELLED_MARKER}`
    : CANCELLED_MARKER;
  assistantParts.push({ type: 'text', text: assistantText });

  // Distinct timestamps keep the pair's order deterministic everywhere it
  // is read back: the Postgres store tie-breaks equal `createdAt` by
  // message id (and `${runId}-assistant` sorts before `${runId}-user`), so
  // sharing one Date would restore the assistant bubble ABOVE the user
  // prompt. One millisecond apart, ASC ordering always shows the prompt
  // first, matching the live chat timeline.
  const userCreatedAt = new Date();
  const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
  return [
    {
      id: `${params.runId}-user`,
      role: 'user',
      createdAt: userCreatedAt,
      threadId: params.threadId,
      resourceId: params.resourceId,
      content: { format: 2, parts: userParts },
    },
    {
      id: `${params.runId}-assistant`,
      role: 'assistant',
      createdAt: assistantCreatedAt,
      threadId: params.threadId,
      resourceId: params.resourceId,
      content: { format: 2, parts: assistantParts },
    },
  ];
}

/**
 * Best-effort persistence of a cancelled turn into Mastra Memory. Never
 * throws: cancellation can become terminal even when persistence fails, so
 * a storage outage must not leave the run lock stuck.
 */
export async function persistCancelledTurn(
  registry: RunRegistry,
  agent: RunnableAgent,
  params: RunExecutionParams,
): Promise<void> {
  try {
    const memory = await agent.getMemory();
    if (!memory?.saveMessages) return;
    const events = registry.getEvents(params.runId) ?? [];
    await memory.saveMessages({
      messages: buildCancelledTurnMessages(params, events) as unknown[],
    });
  } catch {
    // Best-effort: a blank thread is the pre-bridge behavior, never a failure.
  }
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
  let cleanup: (() => void) | undefined;

  try {
    const streamInput: RunStreamInput = params.content
      ? [{ role: 'user', content: params.content }]
      : params.prompt;
    const output = await agent.stream(streamInput, {
      memory: { thread: params.threadId, resource: params.resourceId },
      runId: params.runId,
      abortSignal: params.abortSignal,
    });
    cleanup = output.cleanup;

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
      // Mastra skips persistence for an aborted turn; persist the
      // reconstructed partial turn so the thread stays readable and a
      // later prompt in the same thread can resume from context.
      await persistCancelledTurn(registry, agent, params);
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
      await persistCancelledTurn(registry, agent, params);
    } else {
      registry.finishRun(params.runId, 'failed', sanitizeErrorText(error));
    }
  } finally {
    // Terminal state reached in every path (completed / failed / cancelled):
    // release the durable run's PubSub subscription and registry entry so
    // long-lived servers never accumulate them. Best-effort — a cleanup
    // failure must never mask the terminal state already recorded.
    try {
      cleanup?.();
    } catch {
      // Swallowed: the run registry state is already terminal.
    }
  }
}
