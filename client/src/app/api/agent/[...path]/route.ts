import { type NextRequest } from 'next/server';
import { getDownstreamToken, getUserId } from '@/server/auth';
import { buildAgentProxyUrl, normalizeAgentProxyPath } from '@/server/proxy-url';

export const runtime = 'nodejs';

function isStoredAgentMutation(method: string, path: string[]): boolean {
  if (path[0] !== 'api' || path[1] !== 'stored' || path[2] !== 'agents') return false;
  return (method === 'POST' && path.length === 3)
    || ((method === 'PATCH' || method === 'PUT') && path.length === 4);
}

function hasAllowedMcpConfig(body: string): boolean {
  try {
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    if (!Object.hasOwn(record, 'mcpClients')) return true;

    const mcpClients = record.mcpClients;
    if (!mcpClients || typeof mcpClients !== 'object' || Array.isArray(mcpClients)) return false;
    if (Object.keys(mcpClients).length !== 1) return false;
    const garage = (mcpClients as Record<string, unknown>).garage;
    if (!garage || typeof garage !== 'object' || Array.isArray(garage)) return false;
    if (Object.keys(garage).length !== 1) return false;
    const tools = (garage as Record<string, unknown>).tools;
    return tools !== null
      && typeof tools === 'object'
      && !Array.isArray(tools)
      && Object.keys(tools).length === 0;
  } catch {
    return false;
  }
}

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const userId = await getUserId();
  if (!userId) return new Response('Forbidden', { status: 403 });
  const { path } = await context.params;
  let url: string;
  let authorizationPath: string[];
  try {
    authorizationPath = normalizeAgentProxyPath(path);
    url = buildAgentProxyUrl(process.env.AGENT_URL ?? 'http://localhost:4111', authorizationPath, request.nextUrl.search);
  }
  catch (error) { return new Response(error instanceof Error ? error.message : 'Invalid path', { status: 400 }); }
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  if (isStoredAgentMutation(request.method, authorizationPath) && !hasAllowedMcpConfig(body ?? '')) {
    return new Response('Invalid stored-agent MCP configuration.', { status: 400 });
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
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'no-cache, no-transform',
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
