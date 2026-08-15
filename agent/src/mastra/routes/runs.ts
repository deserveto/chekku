import { registerApiRoute } from '@mastra/core/server';
import {
  RUN_TERMINAL_EVENT_TYPES,
  RunConflictError,
  agentRunRegistry,
  createRunId,
  isRunId,
  type AgentRunEvent,
  type AgentRunSummary,
} from '../runs/run-registry.js';
import {
  ensureFirstTurnThread,
  runExecution,
  type RunnableAgent,
} from '../runs/execute.js';
import {
  isAgentId,
  isOwnedThreadId,
  isResourceId,
} from '../runs/thread-ownership.js';

export const MAX_PROMPT_UTF8_BYTES = 65_536;

export interface StartRunInput {
  agentId: string;
  threadId: string;
  resourceId: string;
  prompt: string;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
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

  return {
    ok: true,
    value: { agentId, threadId, resourceId, prompt: trimmed },
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

    const { agentId, threadId, resourceId, prompt } = parsed.value;
    const agent = resolveAgent(c, agentId);
    if (!agent) {
      return c.json({ error: 'Unknown agent' }, 404);
    }

    // First turn: create the Memory thread record (titled from the prompt)
    // before execution starts, so the thread and its name are visible in
    // listings the moment the run starts — not when Mastra persists the
    // first completed turn.
    await ensureFirstTurnThread(agent, { threadId, resourceId, prompt });

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
      return c.json({ error: 'Could not start the run' }, 500);
    }

    void runExecution(agentRunRegistry, agent, {
      runId,
      agentId,
      threadId,
      resourceId,
      prompt,
      abortSignal: controller.signal,
    });

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

        const subscription = agentRunRegistry.subscribeFrom(runId, offset, send);
        if (!subscription) {
          close();
          return;
        }
        unsubscribe = () => subscription.unsubscribe();
        heartbeat = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(': ping\n\n'));
          }
        }, 15_000);
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
  handler: (c: RunsRouteContext) => {
    const runId = c.req.param('runId') ?? '';
    const resourceId = c.req.query('resourceId') ?? '';

    if (!isRunId(runId) || !isResourceId(resourceId)) {
      return c.json({ error: 'Invalid run or resource identity' }, 400);
    }

    const existing = agentRunRegistry.getRun(runId);
    if (ownershipError(existing, resourceId)) {
      return c.json({ error: 'Run not found' }, 404);
    }

    return c.json({ run: agentRunRegistry.requestCancel(runId) });
  },
});
