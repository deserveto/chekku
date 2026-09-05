import { isDurableAgent } from '@mastra/core/agent/durable';
import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from '@mastra/core/request-context';

import {
  type AgentRunEvent,
  type AgentRunEventType,
  type RunRegistry,
} from './run-registry.js';
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
      /** Mastra's RequestContext: the server-owned channel that carries
       * the authenticated resource id into tool execution. */
      requestContext?: RequestContext;
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
        title?: string;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined
  >;
  createThread(params: {
    threadId: string;
    resourceId: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  /**
   * Merged memory/thread config — the source of the `generateTitle` opt-in
   * the driver-side durable title generation reads. Optional because Memory
   * fakes in tests may omit it.
   */
  getMergedThreadConfig?(config?: unknown): {
    generateTitle?: boolean | Record<string, unknown>;
  } | undefined;
  /**
   * Inserts (or upserts) reconstructed messages into the thread. This is
   * deliberately `saveMessages`, not `updateMessages`: a cancelled turn has
   * new message IDs, so an update-only call silently leaves it absent.
   */
  saveMessages?(params: { messages: unknown[] }): Promise<unknown>;
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
  // surrogate pair in half would end the error in a lone surrogate.
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
 * empty on purpose: a pre-set truncated prompt title would suppress title
 * generation. Returns whether this run opened the thread (its first turn) —
 * the driver uses that flag to generate the LLM title at completion for
 * durable agents, where Mastra's native `generateTitle` hook never runs.
 * Best-effort: on failure, Mastra's own thread creation during the run still
 * applies.
 */
export async function ensureFirstTurnThread(
  agent: RunnableAgent,
  params: { threadId: string; resourceId: string; prompt: string },
): Promise<boolean> {
  try {
    const memory = await agent.getMemory();
    if (!memory) return false;
    const thread = await memory.getThreadById({ threadId: params.threadId });
    if (thread) return false;
    await memory.createThread({
      threadId: params.threadId,
      resourceId: params.resourceId,
    });
    return true;
  } catch {
    // Thread creation is best-effort; the run itself must still start.
    return false;
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
  /**
   * True when this run opened the thread (its first turn). Gates the
   * driver-side title generation durable agents need.
   */
  firstTurn?: boolean;
  /** Signal owned by the route handler; `registry.createRun` received its abort callback. */
  abortSignal: AbortSignal;
}

/**
 * Bounds for the reconstructed cancelled turn. Tool outputs (Reader Markdown
 * can reach ~70 KB per page) are capped per call and in total so the
 * persisted partial turn stays cheap to store and to recall on later turns.
 * Tool-call args get their own small cap: they are model-authored input we
 * replay verbatim, never evidence worth spending budget on.
 */
const MAX_CANCELLED_TOOL_RESULT_CHARS = 6_000;
const MAX_CANCELLED_TOOL_ARGS_CHARS = 2_000;
const MAX_CANCELLED_ASSISTANT_CHARS = 48_000;
/**
 * Streamed assistant text gets its own head+tail cap: a text-heavy
 * cancelled turn would otherwise persist a multi-megabyte assistant row
 * (repeatable per cancel). Head and tail keep the opening and the most
 * recent reasoning — the parts a "lanjutkan" prompt actually needs.
 */
const MAX_CANCELLED_STREAMED_TEXT_CHARS = 24_000;
const CANCELLED_MARKER =
  '_[Run dihentikan oleh pengguna — konteks parsial disimpan agar analisis bisa dilanjutkan di thread ini.]_';
const CANCELLED_TOOL_RESULT_TEXT =
  'Tool call was interrupted before completing (run stopped by the user).';
const OMITTED_TOOL_RESULT_TEXT =
  '[content omitted to bound the persisted partial turn]';

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function boundedString(value: unknown, maxChars: number): string {
  const text = serializeUnknown(value);
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…[truncated]`;
  return text;
}

/**
 * Keeps the original arg shape while its serialized form fits the cap, then
 * degrades to a truncated string. Args are persisted as
 * `toolInvocation.args`, which Mastra converts verbatim into the next
 * provider request's tool-call input.
 */
function boundedToolArgs(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const serialized = serializeUnknown(value);
  if (serialized.length > maxChars) {
    return `${serialized.slice(0, maxChars)}…[truncated]`;
  }
  return value;
}

/**
 * Keeps the head and the tail of an over-long streamed text with a visible
 * truncation marker between them.
 */
function clampStreamedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n…[teks terpotong — output parsial disembunyikan]…\n\n${text.slice(text.length - half)}`;
}

/**
 * One reconstructed tool call, persisted as a Mastra `tool-invocation` part.
 * That is the only tool shape `AIV5Adapter.toUIMessage` converts on recall —
 * raw `tool-call`/`tool-result` parts are skipped by the conversion, so a
 * bridge that writes them loses all tool evidence from the next model
 * prompt in the thread.
 */
interface CancelledToolInvocation {
  toolCallId: string;
  toolName: string;
  /**
   * `result` for completed calls; `output-error` carries a `errorText`
   * result so the next provider request stays valid (a tool-call without
   * any result is rejected by OpenAI-compatible gateways).
   */
  state: 'result' | 'output-error';
  args?: unknown;
  result?: unknown;
  errorText?: string;
  /**
   * Synthetic interrupted marker: the tool did not fail, the run was
   * stopped while it was in flight. The client restore path renders the
   * card as `interrupted`, never as an error — the `output-error` state
   * exists for provider-request validity, not for display.
   */
  interrupted?: boolean;
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
 * Tool activity persists as `tool-invocation` parts (see
 * CancelledToolInvocation) so Mastra's recall conversion keeps the evidence
 * in the thread's model context; the raw `tool-call`/`tool-result` shapes
 * are dropped by that conversion.
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

  const toolInvocations = new Map<string, CancelledToolInvocation>();
  const toolOrder: string[] = [];
  const assistantParts: Array<Record<string, unknown>> = [];
  let streamedText = '';
  let totalChars = 0;

  // Creates (or resolves) the invocation draft for a tool event. A tool
  // result arriving without a prior tool-call still lands here so no
  // evidence is silently dropped.
  const toolFor = (
    payload: Record<string, unknown>,
  ): CancelledToolInvocation | undefined => {
    const toolCallId = String(payload.toolCallId ?? '');
    if (!toolCallId) return undefined;
    let tool = toolInvocations.get(toolCallId);
    if (!tool) {
      tool = {
        toolCallId,
        toolName: String(payload.toolName ?? 'tool'),
        // Provisional: a later tool-result flips it to `result`; an
        // unresolved call keeps the synthetic interrupted error result.
        state: 'output-error',
      };
      toolInvocations.set(toolCallId, tool);
      toolOrder.push(toolCallId);
    }
    return tool;
  };

  for (const event of events) {
    switch (event.type) {
      case 'text-delta': {
        const text = typeof event.payload.text === 'string' ? event.payload.text : '';
        streamedText += text;
        break;
      }
      case 'tool-call': {
        const tool = toolFor(event.payload);
        if (!tool) break;
        const args = boundedToolArgs(
          event.payload.args,
          MAX_CANCELLED_TOOL_ARGS_CHARS,
        );
        if (args !== undefined) tool.args = args;
        break;
      }
      case 'tool-result': {
        const tool = toolFor(event.payload);
        if (!tool) break;
        const value = event.payload.result;
        const serialized = boundedString(value, MAX_CANCELLED_TOOL_RESULT_CHARS);
        totalChars += serialized.length;
        tool.state = 'result';
        delete tool.errorText;
        tool.result =
          totalChars > MAX_CANCELLED_ASSISTANT_CHARS
            ? OMITTED_TOOL_RESULT_TEXT
            : value !== undefined && serialized.length <= MAX_CANCELLED_TOOL_RESULT_CHARS
              ? value
              : serialized;
        break;
      }
      case 'tool-error': {
        const tool = toolFor(event.payload);
        if (!tool) break;
        tool.state = 'output-error';
        tool.errorText = boundedString(
          event.payload.error,
          MAX_CANCELLED_TOOL_RESULT_CHARS,
        );
        break;
      }
      default:
        break;
    }
  }

  // Give every unresolved call a synthetic interrupted result: the next
  // provider request in this thread is rejected if a tool-call has no
  // matching tool-result. `interrupted: true` keeps the restored card from
  // rendering as a genuine failure (N9_3 action item 1).
  for (const toolCallId of toolOrder) {
    const tool = toolInvocations.get(toolCallId);
    if (!tool || tool.state !== 'output-error' || tool.errorText !== undefined) {
      continue;
    }
    tool.errorText = CANCELLED_TOOL_RESULT_TEXT;
    tool.interrupted = true;
  }

  for (const toolCallId of toolOrder) {
    const tool = toolInvocations.get(toolCallId);
    if (tool) assistantParts.push({ type: 'tool-invocation', toolInvocation: tool });
  }

  const assistantText = clampStreamedText(
    streamedText,
    MAX_CANCELLED_STREAMED_TEXT_CHARS,
  );
  const textWithMarker = assistantText
    ? `${assistantText}\n\n${CANCELLED_MARKER}`
    : CANCELLED_MARKER;
  assistantParts.push({ type: 'text', text: textWithMarker });

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
 * Structural view of the title-generation surface Mastra's Agent class
 * exposes (`genTitle`/`resolveTitleGenerationConfig` are public methods the
 * durable wrapper inherits and delegates to the wrapped agent). The
 * `requestContext`/`observabilityContext` parameters are required
 * positionally by the upstream signature but optional at runtime —
 * `generateTitleFromUserMessage` defaults them — so the driver stays
 * decoupled from those types.
 */
interface TitleCapableAgent {
  resolveTitleGenerationConfig(config: unknown): {
    shouldGenerate: boolean;
    model?: unknown;
    instructions?: unknown;
  };
  genTitle(
    userMessage: string,
    requestContext: unknown,
    observabilityContext: unknown,
    model?: unknown,
    instructions?: unknown,
  ): Promise<string | undefined>;
}

function userTextForTitle(params: RunExecutionParams): string {
  if (params.content?.length) {
    return params.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return params.prompt;
}

/**
 * Generates the first-turn thread title for durable agents.
 *
 * The pinned `@mastra/core` durable finish path flushes messages and emits
 * the finish event only — Mastra's native `generateTitle` hook lives in the
 * non-durable `#executeOnFinish`, so without this the threads of every
 * durable-wrapped agent would render the 'New conversation' fallback
 * forever. Mirrors the native flow: resolve the memory's `generateTitle`
 * opt-in, gate on an untitled first turn, generate with the agent's own
 * model through `agent.genTitle`, then persist the title via
 * `memory.createThread` exactly like native does. Plain agents are skipped —
 * their native finish path already titles the thread.
 *
 * Best-effort: a title failure must never affect the completed run.
 */
/**
 * Sanitize a generated thread title: collapse whitespace, strip wrapping
 * quotes, clamp to 80 code points (word-boundary aware). The deterministic
 * fallback behind the strict title instructions — a disobedient model's
 * long echo is clamped instead of stored verbatim.
 */
export function sanitizeThreadTitle(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!collapsed) return undefined;
  const chars = Array.from(collapsed); // code-point safe: never split surrogate pairs/emoji
  if (chars.length <= 80) return chars.join('');
  const cut = chars.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= 40 ? cut.slice(0, lastSpace) : cut).join('').trim() || undefined;
}

export async function generateFirstTurnTitle(
  agent: RunnableAgent,
  params: RunExecutionParams,
): Promise<void> {
  try {
    if (params.firstTurn !== true) return;
    // Plain agents title themselves through Mastra's native finish path;
    // a driver-side call would duplicate that LLM request.
    if (!isDurableAgent(agent)) return;
    const memory = await agent.getMemory();
    if (
      !memory?.getMergedThreadConfig ||
      !memory.getThreadById ||
      !memory.createThread
    ) {
      return;
    }
    const thread = await memory.getThreadById({ threadId: params.threadId });
    if (!thread || thread.title) return;
    const generateTitle = memory.getMergedThreadConfig()?.generateTitle;
    if (!generateTitle) return;

    const titleAgent = agent as RunnableAgent & TitleCapableAgent;
    if (
      typeof titleAgent.resolveTitleGenerationConfig !== 'function' ||
      typeof titleAgent.genTitle !== 'function'
    ) {
      return;
    }
    const { shouldGenerate, model, instructions } =
      titleAgent.resolveTitleGenerationConfig(generateTitle);
    if (!shouldGenerate) return;

    const userText = userTextForTitle(params);
    if (!userText.trim()) return;

    const title = await titleAgent.genTitle(
      userText,
      undefined,
      undefined,
      model,
      instructions,
    );
    const clean = sanitizeThreadTitle(title ?? '');
    if (!clean) return;

    // A manual rename that landed while the title was generating wins.
    const current = await memory.getThreadById({ threadId: params.threadId });
    if (current?.title) return;

    await memory.createThread({
      threadId: params.threadId,
      resourceId: params.resourceId,
      title: clean,
      ...(thread.metadata !== undefined ? { metadata: thread.metadata } : {}),
    });
  } catch {
    // Best-effort: the run is already completed; an untitled thread is the
    // pre-existing behavior, never a failure.
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
    // Server-owned tenant identity rides the reserved RequestContext key so
    // tools (e.g. search_knowledge_base) resolve the tenant deterministically
    // instead of relying on framework-assembled context members. The value
    // equals the memory option's resource, so core's precedence is harmless.
    const requestContext: RequestContext = new RequestContext([
      [MASTRA_RESOURCE_ID_KEY, params.resourceId],
    ]);
    const output = await agent.stream(streamInput, {
      memory: { thread: params.threadId, resource: params.resourceId },
      runId: params.runId,
      abortSignal: params.abortSignal,
      requestContext,
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
    if (!sawError) {
      // Durable agents never reach Mastra's native first-turn title hook;
      // generate it driver-side. See generateFirstTurnTitle.
      await generateFirstTurnTitle(agent, params);
    }
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
