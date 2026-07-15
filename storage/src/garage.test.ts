import { describe, expect, it } from 'vitest';

import {
  createGarageObjectStorage,
  createLazyGarageObjectStorage,
  readGarageConfig,
} from './garage.ts';
import { ObjectStorageError } from './objects.ts';

const config = {
  endpoint: 'https://garage.example.test',
  region: 'garage',
  bucket: 'objects',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
};

function sdkError(name: string, status: number): Error {
  return Object.assign(new Error('unsafe provider details'), {
    name,
    $metadata: { httpStatusCode: status, requestId: 'secret-request-id' },
  });
}

describe('Garage object storage', () => {
  it('reports missing Garage configuration without exposing values', () => {
    expect(() => readGarageConfig({})).toThrow(expect.objectContaining({
      code: 'configuration',
      message: 'Garage object storage is not configured.',
    }));
  });

  it('trims all five Garage environment values', () => {
    expect(readGarageConfig({
      GARAGE_ENDPOINT: ' https://garage.example.test ',
      GARAGE_REGION: ' garage ',
      GARAGE_BUCKET: ' objects ',
      GARAGE_ACCESS_KEY_ID: ' access-key ',
      GARAGE_SECRET_ACCESS_KEY: ' secret-key ',
    })).toEqual(config);
  });

  it('defers Garage configuration validation until first use', async () => {
    const store = createLazyGarageObjectStorage({});

    await expect(store.ensureReady?.()).rejects.toMatchObject({
      code: 'configuration',
      message: 'Garage object storage is not configured.',
    });
  });

  it('creates text only when its key does not exist', async () => {
    let sentCommand: { input: unknown } | undefined;
    const store = createGarageObjectStorage(config, {
      async send(command) {
        sentCommand = command as { input: unknown };
        return {};
      },
    });

    await expect(store.createText('notes/a.txt', 'hello', 'text/plain')).resolves.toBeUndefined();
    expect(sentCommand?.input).toMatchObject({
      Bucket: 'objects',
      Key: 'notes/a.txt',
      Body: 'hello',
      ContentType: 'text/plain',
      IfNoneMatch: '*',
    });
  });

  it('translates create collisions to a safe error', async () => {
    const store = createGarageObjectStorage(config, {
      async send() {
        throw sdkError('PreconditionFailed', 412);
      },
    });

    await expect(store.createText('notes/a.txt', 'again')).rejects.toMatchObject({
      code: 'already-exists',
      message: 'Object already exists.',
    });
  });

  it('checks existence before replacing text', async () => {
    const commands: Array<{ constructor: { name: string }; input: unknown }> = [];
    const store = createGarageObjectStorage(config, {
      async send(command) {
        commands.push(command as (typeof commands)[number]);
        return {};
      },
    });

    await store.replaceText('notes/a.txt', 'new value');

    expect(commands.map(({ constructor, input }) => ({ name: constructor.name, input }))).toEqual([
      { name: 'HeadObjectCommand', input: { Bucket: 'objects', Key: 'notes/a.txt' } },
      {
        name: 'PutObjectCommand',
        input: {
          Bucket: 'objects',
          Key: 'notes/a.txt',
          Body: 'new value',
          ContentType: undefined,
        },
      },
    ]);
  });

  it('returns UTF-8 text and translates missing reads', async () => {
    const readable = createGarageObjectStorage(config, {
      async send() {
        return { Body: new TextEncoder().encode('日本語 note') };
      },
    });
    const missing = createGarageObjectStorage(config, {
      async send() {
        throw sdkError('NoSuchKey', 404);
      },
    });

    await expect(readable.getText('notes/a.txt')).resolves.toBe('日本語 note');
    await expect(missing.getText('missing')).rejects.toMatchObject({
      code: 'not-found',
      message: 'Object not found.',
    });
  });

  it('checks whether keys exist', async () => {
    const existing = createGarageObjectStorage(config, { async send() { return {}; } });
    const missing = createGarageObjectStorage(config, {
      async send() {
        throw sdkError('NotFound', 404);
      },
    });

    await expect(existing.exists('notes/a.txt')).resolves.toBe(true);
    await expect(missing.exists('missing')).resolves.toBe(false);
  });

  it('returns a bounded key list and truncation state', async () => {
    let sentCommand: { input: unknown } | undefined;
    const expectedKeys = ['notes/a.txt', 'notes/b.txt'];
    const store = createGarageObjectStorage(config, {
      async send(command) {
        sentCommand = command as { input: unknown };
        return {
          Contents: [{ Key: expectedKeys[0] }, {}, { Key: expectedKeys[1] }],
          IsTruncated: true,
        };
      },
    });

    await expect(store.listKeys('notes/', { limit: 100 })).resolves.toEqual({
      keys: expectedKeys,
      truncated: true,
    });
    expect(sentCommand?.input).toEqual({
      Bucket: 'objects',
      Prefix: 'notes/',
      MaxKeys: 100,
    });
  });

  it('checks existence before deleting and reports missing keys', async () => {
    const missing = createGarageObjectStorage(config, {
      async send() {
        throw sdkError('NotFound', 404);
      },
    });

    await expect(missing.delete('missing')).rejects.toMatchObject({
      code: 'not-found',
      message: 'Object not found.',
    });
  });

  it('translates connectivity failures without leaking SDK details', async () => {
    const store = createGarageObjectStorage(config, {
      async send() {
        throw Object.assign(new Error('connect ECONNREFUSED garage.internal'), {
          name: 'TimeoutError',
          code: 'ECONNREFUSED',
        });
      },
    });

    await expect(store.exists('notes/a.txt')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Object storage is unavailable.',
    });
  });

  it('sanitizes unknown SDK failures', async () => {
    const unsafeFailure = Object.assign(
      new Error('https://garage.internal secret-key authorization=secret provider failure'),
      {
        endpoint: 'https://garage.internal',
        credential: 'secret-key',
        headers: { authorization: 'secret' },
        providerBody: '<Error>provider failure</Error>',
        $metadata: { requestId: 'request-secret' },
      },
    );
    const store = createGarageObjectStorage(config, {
      async send() {
        throw unsafeFailure;
      },
    });

    const failure = await store.getText('notes/a.txt').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ObjectStorageError);
    expect(failure).toMatchObject({
      code: 'unavailable',
      message: 'Object storage is unavailable.',
    });
    expect(failure).not.toBe(unsafeFailure);
    expect(JSON.stringify(failure)).not.toMatch(
      /garage\.internal|secret-key|authorization|provider failure|request-secret/,
    );
  });
});
