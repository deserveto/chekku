import { registerApiRoute } from '@mastra/core/server';

const VERSION = '0.1.0';

type RouteContext = {
  get?(key: string): unknown;
};

export const healthRoute = registerApiRoute('/healthz', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c: RouteContext) => {
    const mastra = c.get?.('mastra') as { getStorage?: () => unknown } | undefined;
    const timestamp = new Date().toISOString();
    if (mastra?.getStorage && !mastra.getStorage()) {
      return Response.json({ status: 'degraded', service: 'chekku-agent-server', version: VERSION, timestamp }, { status: 503 });
    }
    return Response.json({ status: 'ok', service: 'chekku-agent-server', version: VERSION, timestamp }, { status: 200 });
  },
});
