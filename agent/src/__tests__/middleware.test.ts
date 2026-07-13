import { describe, expect, it } from 'vitest';
import { requestIdInjector, requestLogger } from '../config/middleware.js';

describe('server middleware', () => {
  it('uses incoming request id and echoes it in response header', async () => {
    const values = new Map<string, unknown>();
    const headers = new Map<string, string>();
    const context = {
      req: { method: 'GET', url: 'http://localhost/healthz', header: (name: string) => name === 'x-request-id' ? 'req-123' : undefined },
      set: (key: string, value: unknown) => values.set(key, value),
      header: (name: string, value: string) => headers.set(name, value),
    };

    await requestIdInjector(context, async () => undefined);

    expect(values.get('requestId')).toBe('req-123');
    expect(headers.get('x-request-id')).toBe('req-123');
  });

  it('continues through requestLogger', async () => {
    let called = false;
    await requestLogger({ req: { method: 'GET', url: 'http://localhost/healthz', header: () => undefined }, set: () => undefined, header: () => undefined }, async () => {
      called = true;
    });

    expect(called).toBe(true);
  });
});
