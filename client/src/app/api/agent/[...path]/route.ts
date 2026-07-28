import { type NextRequest } from 'next/server';
import { getDownstreamToken, getUserId } from '@/server/auth';
import { buildAgentProxyUrl, normalizeAgentProxyPath } from '@/server/proxy-url';
import { STUDIO_MCP_CLIENT_IDS } from '../../../../server/agent-payload';

export const runtime = 'nodejs';

const allowedMcpClientIds = new Set<string>(STUDIO_MCP_CLIENT_IDS);

function isStoredAgentMutation(method: string, path: string[]): boolean {
  if (path[0] !== 'api' || path[1] !== 'stored' || path[2] !== 'agents') return false;
  return (method === 'POST' && path.length === 3)
    || ((method === 'PATCH' || method === 'PUT') && path.length === 4);
}

function isEmptyToolsSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'tools') return false;
  const tools = (value as Record<string, unknown>).tools;
  return Boolean(tools)
    && typeof tools === 'object'
    && !Array.isArray(tools)
    && Object.keys(tools as Record<string, unknown>).length === 0;
}

function hasAllowedMcpConfig(body: string): boolean {
  try {
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    if (!Object.hasOwn(record, 'mcpClients')) return true;

    const mcpClients = record.mcpClients;
    if (!mcpClients || typeof mcpClients !== 'object' || Array.isArray(mcpClients)) return false;
    const entries = Object.entries(mcpClients as Record<string, unknown>);
    return entries.length > 0
      && entries.length <= STUDIO_MCP_CLIENT_IDS.length
      && entries.every(([id, value]) =>
        allowedMcpClientIds.has(id) && isEmptyToolsSelection(value));
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
