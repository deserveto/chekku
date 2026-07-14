import { describe, expect, it } from 'vitest';

import { createLazyGarageReportStore, readGarageConfig } from './garage-store.js';

describe('Garage PM report store', () => {
  it('throws a clear error when Garage env vars are missing', () => {
    expect(() => readGarageConfig({})).toThrow(/Garage storage not configured/);
  });

  it('reads Garage S3-compatible config from env', () => {
    expect(readGarageConfig({
      GARAGE_ENDPOINT: 'https://garage.example.test',
      GARAGE_REGION: 'garage',
      GARAGE_BUCKET: 'pm-reports',
      GARAGE_ACCESS_KEY_ID: 'access-key',
      GARAGE_SECRET_ACCESS_KEY: 'secret-key',
    })).toEqual({
      endpoint: 'https://garage.example.test',
      region: 'garage',
      bucket: 'pm-reports',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    });
  });

  it('defers Garage config validation until first storage operation', async () => {
    const store = createLazyGarageReportStore();

    await expect(store.ensureReady?.()).rejects.toThrow(/Garage storage not configured/);
  });
});
