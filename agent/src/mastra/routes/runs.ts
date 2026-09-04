import { registerApiRoute } from '@mastra/core/server';
import {
  RUN_TERMINAL_EVENT_TYPES,
  RunCapacityError,
  RunConflictError,
  agentRunRegistry,
  createRunId,
  isRunId,
  type AgentRunEvent,
  type AgentRunSummary,
} from '../runs/run-registry.js';
import {
  ensureFirstTurnThread,
  persistCancelledTurn,
  runExecution,
  type RunUserContent,
  type RunnableAgent,
} from '../runs/execute.js';
import {
  isAgentId,
  isOwnedThreadId,
  isResourceId,
} from '../runs/thread-ownership.js';
import { TokenQuotaExceededError, tokenQuotaStore } from '../runs/token-quota.js';

export const MAX_PROMPT_UTF8_BYTES = 65_536;

/**
 * Server-side bounds for the optional multimodal `content` array. The client
 * contract (8 attachments, each PDF up to 20 pages, 8 MiB total base64, text
 * files wrapped into one text part) sets the legitimate maximum at 1 text
 * part + 160 image parts, so the part cap leaves headroom above it while
 * still bounding what a scripted client can push into Mastra Memory.
 */
export const MAX_CONTENT_PARTS = 200;
export const MAX_CONTENT_TEXT_CHARS = 2_621_440;
export const MAX_CONTENT_IMAGE_BASE64_CHARS = 2_097_152;
export const MAX_CONTENT_TOTAL_IMAGE_BASE64_CHARS = 8_388_608;
export const MAX_CONTENT_FILENAME_CHARS = 256;

export interface StartRunInput {
  agentId: string;
  threadId: string;
  resourceId: string;
  prompt: string;
  content?: RunUserContent;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parseRunContent(value: unknown): RunUserContent | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length > MAX_CONTENT_PARTS) return undefined;

  const parts: RunUserContent = [];
  let totalImageChars = 0;
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      return undefined;
    }
    const record = part as Record<string, unknown>;
    if (record.type === 'text') {
      if (typeof record.text !== 'string' || !record.text) return undefined;
      if (record.text.length > MAX_CONTENT_TEXT_CHARS) return undefined;
      parts.push({ type: 'text', text: record.text });
      continue;
    }
    if (record.type === 'image') {
      if (
        typeof record.image !== 'string' ||
        !record.image ||
        record.image.startsWith('data:') ||
        typeof record.mimeType !== 'string' ||
        !record.mimeType.startsWith('image/')
      ) {
        return undefined;
      }
      if (record.image.length > MAX_CONTENT_IMAGE_BASE64_CHARS) return undefined;
      totalImageChars += record.image.length;
      if (totalImageChars > MAX_CONTENT_TOTAL_IMAGE_BASE64_CHARS) {
        return undefined;
      }
      const filename =
        typeof record.filename === 'string' && record.filename
          ? record.filename
          : undefined;
      if (filename && filename.length > MAX_CONTENT_FILENAME_CHARS) {
        return undefined;
      }
      parts.push({
        type: 'image',
        image: record.image,
        mimeType: record.mimeType,
        ...(filename ? { filename } : {}),
      });
      continue;
    }
    return undefined;
  }
  return parts;
}

export function parseStartRunRequest(
  body: unknown,
): { ok: true; value: StartRunInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const record = body as Record<string, unknown>;
  const agentId = record.agentId;
  const resourceId = record.resourceId;
  const threadId = record.threadId;
  const prompt = record.prompt;
  const content = parseRunContent(record.content);

  if (typeof agentId !== 'string' || !isAgentId(agentId)) {
    return { ok: false, error: 'agentId must use lowercase kebab-case' };
  }
  if (typeof resourceId !== 'string' || !isResourceId(resourceId)) {
    return { ok: false, error: 'resourceId contains unsupported characters' };
  }
  if (
    typeof threadId !== 'string' ||
    !isOwnedThreadId(threadId, agentId, resourceId)
  ) {
    return {
      ok: false,
      error: 'Thread does not belong to this agent and resource',
    };
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'prompt is required' };
  }
  const trimmed = prompt.trim();
  if (utf8Bytes(trimmed) > MAX_PROMPT_UTF8_BYTES) {
    return { ok: false, error: 'prompt exceeds the maximum length' };
  }
  if (record.content !== undefined && !content) {
    return { ok: false, error: 'content must be valid multimodal message parts' };
  }

  return {
    ok: true,
    value: {
      agentId,
      threadId,
      resourceId,
      prompt: trimmed,
      ...(content ? { content } : {}),
    },
  };
}

type MastraLike = {
  getAgentById(id: string): unknown;
};

type RunsRouteContext = {
  req: {
    json: () => Promise<unknown>;
    param: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    raw: { signal: AbortSignal };
  };
  get?: (key: string) => unknown;
  json: (body: unknown, status?: number) => Response;
};

function resolveMastra(c: RunsRouteContext): MastraLike | undefined {
  return c.get?.('mastra') as MastraLike | undefined;
}

export function resolveAgent(
  c: RunsRouteContext,
  agentId: string,
): RunnableAgent | null {
  try {
    // getAgentById resolves by the agent's public id (e.g. 'main-agent');
    // the registry keys ('mainAgent', ...) are internal composition names.
    const agent = resolveMastra(c)?.getAgentById(agentId);
    if (
      agent &&
      typeof (agent as RunnableAgent).stream === 'function' &&
      typeof (agent as RunnableAgent).getMemory === 'function'
    ) {
      return agent as RunnableAgent;
    }
    return null;
  } catch {
    return null;
  }
}

function ownershipError(run: AgentRunSummary | null, resourceId: string) {
  return !run || run.resourceId !== resourceId;
}

export const startRunRoute = registerApiRoute('/runs', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c: RunsRouteContext) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parseStartRunRequest(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    const { agentId, threadId, resourceId, prompt, content } = parsed.value;
    const agent = resolveAgent(c, agentId);
    if (!agent) {
      return c.json({ error: 'Unknown agent' }, 404);
    }

    // Token quota gate: a blocked user gets a fixed 429 before any thread
    // record or run registry state is created. Duplicate-run attach is NOT
    // new spend: when this thread already has an active run, the 409
    // attach contract wins even if the user's quota tipped over mid-run.
    if (!agentRunRegistry.findActiveRun(agentId, threadId, resourceId)) {
      try {
        tokenQuotaStore.assertQuota(resourceId);
      } catch (error) {
        if (error instanceof TokenQuotaExceededError) {
          return c.json({ error: error.message }, 429);
        }
        throw error;
      }
    }

    // First turn: create the Memory thread record untitled before execution
    // starts, so the thread is visible in listings the moment the run
    // starts, not when the first completed turn persists. The title is
    // generated at first-turn completion — natively for plain agents, and
    // driver-side by runExecution for durable agents (the durable finish
    // path never runs Mastra's generateTitle hook).
    const firstTurn = await ensureFirstTurnThread(agent, {
      threadId,
      resourceId,
      prompt,
    });

    const runId = createRunId();
    const controller = new AbortController();
    let run: AgentRunSummary;
    try {
      run = agentRunRegistry.createRun({
        id: runId,
        agentId,
        threadId,
        resourceId,
        prompt,
        requestAbort: () => controller.abort(),
      });
    } catch (error) {
      if (error instanceof RunConflictError) {
        return c.json(
          { error: 'A run is already active for this thread', run: error.run },
          409,
        );
      }
      if (error instanceof RunCapacityError) {
        // Fixed bounded message from the registry; no diagnostics.
        return c.json({ error: error.message }, 429);
      }
      return c.json({ error: 'Could not start the run' }, 500);
    }

    void runExecution(
      agentRunRegistry,
      agent,
      {
        runId,
        agentId,
        threadId,
        resourceId,
        prompt,
        ...(content ? { content } : {}),
        ...(firstTurn ? { firstTurn } : {}),
        abortSignal: controller.signal,
      },
      tokenQuotaStore,
    );

    return c.json({ run }, 202);
  },
});

export const activeRunRoute = registerApiRoute('/runs/active', {
  method: 'GET',
  requiresAuth: false,
  handler: (c: RunsRouteContext) => {
    const agentId = c.req.query('agentId') ?? '';
    const threadId = c.req.query('threadId') ?? '';
    const resourceId = c.req.query('resourceId') ?? '';

    if (!isAgentId(agentId) || !isResourceId(resourceId)) {
      return c.json({ error: 'Invalid agent or resource identity' }, 400);
    }
    if (!isOwnedThreadId(threadId, agentId, resourceId)) {
      return c.json(
        { error: 'Thread does not belong to this agent and resource' },
        400,
      );
    }

    const run = agentRunRegistry.findActiveRun(agentId, threadId, resourceId);
    if (!run) return new Response(null, { status: 204 });
    return c.json({ run });
  },
});

export const listRunsRoute = registerApiRoute('/runs/list', {
  method: 'GET',
  requiresAuth: false,
  handler: (c: RunsRouteContext) => {
    const resourceId = c.req.query('resourceId') ?? '';
    const agentIdParam = c.req.query('agentId');

    if (!isResourceId(resourceId)) {
      return c.json({ error: 'Invalid resource identity' }, 400);
    }
    if (agentIdParam !== undefined && !isAgentId(agentIdParam)) {
      return c.json({ error: 'Invalid agent identity' }, 400);
    }

    return c.json({
      runs: agentRunRegistry.listActiveRuns(resourceId, agentIdParam),
    });
  },
});

export const runStatusRoute = registerApiRoute('/runs/:runId', {
  method: 'GET',
  requiresAuth: false,
  handler: (c: RunsRouteContext) => {
    const runId = c.req.param('runId') ?? '';
    const resourceId = c.req.query('resourceId') ?? '';

    if (!isRunId(runId) || !isResourceId(resourceId)) {
      return c.json({ error: 'Invalid run or resource identity' }, 400);
    }

    const run = agentRunRegistry.getRun(runId);
    if (ownershipError(run, resourceId)) {
      return c.json({ error: 'Run not found' }, 404);
    }
    return c.json({ run });
  },
});

export const runEventsRoute = registerApiRoute('/runs/:runId/events', {
  method: 'GET',
  requiresAuth: false,
  handler: (c: RunsRouteContext) => {
    const runId = c.req.param('runId') ?? '';
    const resourceId = c.req.query('resourceId') ?? '';
    const offsetParam = c.req.query('offset');

    if (!isRunId(runId) || !isResourceId(resourceId)) {
      return c.json({ error: 'Invalid run or resource identity' }, 400);
    }
    let offset = 0;
    if (offsetParam !== undefined) {
      const parsed = Number.parseInt(offsetParam, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json({ error: 'offset must be a non-negative integer' }, 400);
      }
      offset = parsed;
    }

    const run = agentRunRegistry.getRun(runId);
    if (ownershipError(run, resourceId)) {
      return c.json({ error: 'Run not found' }, 404);
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          unsubscribe?.();
        };
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed by the consumer.
          }
        };
        const send = (event: AgentRunEvent) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
          if (RUN_TERMINAL_EVENT_TYPES.includes(event.type)) {
            close();
          }
        };

        // The heartbeat must exist before replay: subscribeFrom replays
        // buffered events synchronously, and a replayed terminal event
        // closes the stream immediately — cleanup then clears the interval.
        // Assigning it afterwards would leave an uncleared interval behind
        // for the process lifetime (every later close path early-returns
        // on `closed`).
        heartbeat = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(': ping\n\n'));
          }
        }, 15_000);

        const subscription = agentRunRegistry.subscribeFrom(runId, offset, send);
        if (!subscription) {
          close();
          return;
        }
        unsubscribe = () => subscription.unsubscribe();
        c.req.raw.signal.addEventListener('abort', close);
      },
      cancel() {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  },
});

export const cancelRunRoute = registerApiRoute('/runs/:runId/cancel', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c: RunsRouteContext) => {
    const runId = c.req.param('runId') ?? '';
    const resourceId = c.req.query('resourceId') ?? '';

    if (!isRunId(runId) || !isResourceId(resourceId)) {
      return c.json({ error: 'Invalid run or resource identity' }, 400);
    }

    const existing = agentRunRegistry.getRun(runId);
    if (ownershipError(existing, resourceId)) {
      return c.json({ error: 'Run not found' }, 404);
    }

    const run = agentRunRegistry.requestCancel(runId);
    if (!run) return c.json({ error: 'Run not found' }, 404);

    // A durable tool step can take up to its own bounded timeout to observe
    // the abort signal. Release this thread's run lock NOW, rather than
    // making the user wait for that unrelated drain (or a slow Postgres
    // write) before they can continue the conversation. The snapshot persist
    // is fire-and-forget: runExecution saves the same IDs again when its
    // stream finally unwinds (saveMessages is an upsert), so the early
    // snapshot is an optimization, never a correctness requirement.
    if (run.status === 'running') {
      const finished = agentRunRegistry.finishRun(runId, 'cancelled');
      const agent = resolveAgent(c, run.agentId);
      if (agent) {
        void persistCancelledTurn(agentRunRegistry, agent, {
          runId: run.id,
          agentId: run.agentId,
          threadId: run.threadId,
          resourceId: run.resourceId,
          prompt: run.prompt,
          abortSignal: new AbortController().signal,
        }).catch(() => undefined);
      }
      return c.json({ run: finished });
    }

    return c.json({ run });
  },
});
