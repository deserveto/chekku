import { type NextRequest } from 'next/server';
import { getDownstreamToken, getUserId } from '@/server/auth';
import { buildAgentProxyUrl } from '@/server/proxy-url';

export const runtime = 'nodejs';

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const userId = await getUserId();
  if (!userId) return new Response('Forbidden', { status: 403 });
  const { path } = await context.params;
  let url: string;
  try { url = buildAgentProxyUrl(process.env.AGENT_URL ?? 'http://localhost:4111', path, request.nextUrl.search); }
  catch (error) { return new Response(error instanceof Error ? error.message : 'Invalid path', { status: 400 }); }
  const token = await getDownstreamToken(userId);
  const upstream = await fetch(url, {
    method: request.method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': request.headers.get('content-type') ?? 'application/json',
      Accept: request.headers.get('accept') ?? '*/*',
    },
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
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
