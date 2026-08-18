import { type NextRequest } from 'next/server';
import { getDownstreamToken, getUserId } from '@/server/auth';
import { buildRunsProxyUrl } from '@/server/proxy-url';
import { isOwnedThreadId } from '@/lib/thread-id';

export const runtime = 'nodejs';

const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Same-origin boundary for the server-owned agent-run surface.
 *
 * Identity rule: the authenticated session user IS the resourceId. The
 * browser never supplies a resourceId — this route injects it and
 * verifies thread ownership before anything reaches the agent server.
 */
async function handler(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const userId = await getUserId();
  if (!userId) return new Response('Forbidden', { status: 403 });

  const { path = [] } = await context.params;
  const incomingSearch = new URLSearchParams(request.nextUrl.search);

  let upstreamSearch = new URLSearchParams();
  let body: string | undefined;

  if (path.length === 0 && request.method === 'POST') {
    const raw = await request.text();
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      return jsonError('Request body must be valid JSON', 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonError('Request body must be a JSON object', 400);
    }

    const { agentId, threadId, prompt } = payload as Record<string, unknown>;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) {
      return jsonError('agentId must use lowercase kebab-case', 400);
    }
    if (typeof threadId !== 'string' || typeof prompt !== 'string') {
      return jsonError('threadId and prompt are required', 400);
    }
    if (!isOwnedThreadId(threadId, agentId, userId)) {
      return jsonError('Thread does not belong to this user and agent', 400);
    }

    // resourceId is server-derived: any client-sent value is discarded.
    body = JSON.stringify({ agentId, threadId, prompt, resourceId: userId });
    upstreamSearch = new URLSearchParams();
  } else if (path[0] === 'active' && request.method === 'GET') {
    const agentId = incomingSearch.get('agentId') ?? '';
    const threadId = incomingSearch.get('threadId') ?? '';
    if (!AGENT_ID.test(agentId)) {
      return jsonError('agentId must use lowercase kebab-case', 400);
    }
    if (!isOwnedThreadId(threadId, agentId, userId)) {
      return jsonError('Thread does not belong to this user and agent', 400);
    }
    upstreamSearch = new URLSearchParams({
      agentId,
      threadId,
      resourceId: userId,
    });
  } else if (path[0] === 'list' && request.method === 'GET') {
    upstreamSearch = new URLSearchParams({ resourceId: userId });
    const agentId = incomingSearch.get('agentId');
    if (agentId) {
      if (!AGENT_ID.test(agentId)) {
        return jsonError('agentId must use lowercase kebab-case', 400);
      }
      upstreamSearch.set('agentId', agentId);
    }
  } else if (
    (path.length === 1 && request.method === 'GET') ||
    (path.length === 2 && path[1] === 'events' && request.method === 'GET') ||
    (path.length === 2 && path[1] === 'cancel' && request.method === 'POST')
  ) {
    upstreamSearch = new URLSearchParams(incomingSearch);
    upstreamSearch.set('resourceId', userId);
    if (request.method === 'POST') {
      body = (await request.text()) || undefined;
    }
  } else {
    return jsonError('Unsupported run operation', 404);
  }

  let url: string;
  try {
    url = buildRunsProxyUrl(
      process.env.AGENT_URL ?? 'http://localhost:4111',
      path,
      upstreamSearch.toString() ? `?${upstreamSearch.toString()}` : '',
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Invalid path',
      400,
    );
  }

  const token = await getDownstreamToken(userId);
  const upstream = await fetch(url, {
    method: request.method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': request.headers.get('content-type') ?? 'application/json',
      Accept: request.headers.get('accept') ?? '*/*',
    },
    body,
    // @ts-expect-error Node fetch requires duplex for streaming request bodies.
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control':
        upstream.headers.get('cache-control') ?? 'no-cache, no-transform',
    },
  });
}

export const GET = handler;
export const POST = handler;
