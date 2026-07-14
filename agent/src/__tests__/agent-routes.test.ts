import { describe, expect, it } from 'vitest';
import type { ApiRoute } from '@mastra/core/server';
import { healthRoute } from '../mastra/routes/health.js';
import { mastra } from '../mastra/index.js';

async function json(response: unknown): Promise<unknown> {
  return await (response as Response).json();
}

describe('agent server routes', () => {
  it('healthz returns Chekku service metadata', async () => {
    const route = healthRoute as ApiRoute & { handler: (c: unknown) => Promise<Response> };
    const response = await route.handler({ get: () => ({ getStorage: () => ({}) }) });

    expect((response as Response).status).toBe(200);
    expect(await json(response)).toEqual({
      status: 'ok',
      service: 'chekku-agent-server',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('registers the reconstructed server routes', () => {
    expect(Object.keys(mastra.listAgents()).sort()).toEqual([
      'mainAgent',
      'pmAgent',
      'qaWebAgent',
    ]);

    const server = mastra.getServer();

    expect(server?.cors).toMatchObject({
      origin: 'http://localhost:3000',
    });

    expect(server?.middleware).toHaveLength(2);

    const routePaths = server?.apiRoutes?.map((route) => route.path) ?? [];

    expect(routePaths).toEqual(
      expect.arrayContaining([
        '/healthz',
        '/models',
      ]),
    );

    expect(routePaths).not.toContain('/api/model-info');
    expect(routePaths).not.toContain('/api/conversations');
  });
});
