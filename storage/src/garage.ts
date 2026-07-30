import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  ObjectStorageError,
  type BinaryObjectResult,
  type BinaryObjectStorage,
  type ObjectListResult,
} from './objects.ts';

export interface GarageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type RawEnv = Record<string, unknown>;

interface GarageClient {
  send(command: unknown): Promise<unknown>;
}

interface ErrorDetails {
  name?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

interface ObjectResponse {
  Body?: unknown;
}

interface ListResponse {
  Contents?: Array<{ Key?: string }>;
  IsTruncated?: boolean;
}

const SAFE_MESSAGES = {
  alreadyExists: 'Object already exists.',
  configuration: 'Garage object storage is not configured.',
  notFound: 'Object not found.',
  unavailable: 'Object storage is unavailable.',
} as const;

function readEnv(raw: RawEnv, name: string): string | undefined {
  const value = raw[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readGarageConfig(raw: RawEnv = process.env): GarageConfig {
  const endpoint = readEnv(raw, 'GARAGE_ENDPOINT');
  const region = readEnv(raw, 'GARAGE_REGION');
  const bucket = readEnv(raw, 'GARAGE_BUCKET');
  const accessKeyId = readEnv(raw, 'GARAGE_ACCESS_KEY_ID');
  const secretAccessKey = readEnv(raw, 'GARAGE_SECRET_ACCESS_KEY');

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new ObjectStorageError('configuration', SAFE_MESSAGES.configuration);
  }

  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

function errorDetails(error: unknown): ErrorDetails {
  return typeof error === 'object' && error !== null ? error as ErrorDetails : {};
}

function isNotFound(error: unknown): boolean {
  const { name, $metadata } = errorDetails(error);
  return name === 'NoSuchKey'
    || name === 'NotFound'
    || (name !== 'NoSuchBucket' && $metadata?.httpStatusCode === 404);
}

function translateError(error: unknown, collision = false): never {
  if (error instanceof ObjectStorageError) throw error;

  const { name, code, $metadata } = errorDetails(error);
  const status = $metadata?.httpStatusCode;
  if (collision && (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412)) {
    throw new ObjectStorageError('already-exists', SAFE_MESSAGES.alreadyExists);
  }
  if (
    name === 'NoSuchBucket' ||
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'AccessDenied' ||
    status === 401 ||
    status === 403
  ) {
    throw new ObjectStorageError('configuration', SAFE_MESSAGES.configuration);
  }
  if (isNotFound(error)) {
    throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
  }
  if (
    name === 'TimeoutError' ||
    name === 'RequestTimeout' ||
    name === 'RequestTimeoutException' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    (typeof status === 'number' && status >= 500)
  ) {
    throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
  }

  throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
}

async function bodyToString(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToString' in body &&
    typeof body.transformToString === 'function'
  ) {
    return body.transformToString();
  }
  throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
}

/**
 * Upper bound on a single binary object read. Mirrors the bounded-reader
 * pattern used by the hosted Web Reader client: a streamed body that exceeds
 * this cap is cancelled and surfaced as a safe `unavailable` error before the
 * bytes ever reach the caller. The cap is well above any image the visual
 * content pipeline produces (≤ 10 MiB) while keeping unbounded streams from
 * consuming memory.
 */
const MAX_BINARY_BODY_BYTES = 16 * 1024 * 1024;

interface BinaryObjectResponse {
  Body?: unknown;
  ContentType?: unknown;
}

async function readBoundedBytes(response: {
  Body?: unknown;
  ContentType?: unknown;
}): Promise<BinaryObjectResult> {
  const body = response.Body;
  if (body == null) {
    throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
  }
  let contentType: string | undefined;
  if (typeof response.ContentType === 'string' && response.ContentType.length > 0) {
    contentType = response.ContentType;
  }

  const collect = async (
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_BINARY_BODY_BYTES) {
        try {
          await (source as ReadableStream<Uint8Array>).cancel?.();
        } catch {
          // Cleanup must not replace the fixed size error.
        }
        throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
      }
      chunks.push(chunk);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  };

  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_BINARY_BODY_BYTES) {
      throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
    }
    return { value: body, ...(contentType ? { contentType } : {}) };
  }

  // On Node, `@aws-sdk/client-s3` returns `Body` as an `SdkStream` wrapping a
  // Node `Readable`, which is async-iterable but NOT a global `ReadableStream`.
  // Route every async-iterable body (web ReadableStream included) through the
  // streaming `collect()` so the cap cancels the stream mid-flight instead of
  // materializing the whole object first. Only fall back to the buffered
  // `transformToByteArray()` shape for bodies that expose neither protocol.
  if (body instanceof ReadableStream || isAsyncIterable(body)) {
    const value = await collect(body as ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>);
    return { value, ...(contentType ? { contentType } : {}) };
  }

  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    const bytes = await body.transformToByteArray();
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (value.byteLength > MAX_BINARY_BODY_BYTES) {
      throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
    }
    return { value, ...(contentType ? { contentType } : {}) };
  }

  throw new ObjectStorageError('unavailable', SAFE_MESSAGES.unavailable);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

function createClient(config: GarageConfig): GarageClient {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }) as GarageClient;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 1000;
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

export function createGarageObjectStorage(
  config: GarageConfig = readGarageConfig(),
  client: GarageClient = createClient(config),
): BinaryObjectStorage {
  const mutationTails = new Map<string, Promise<void>>();
  const mutate = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutationTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutationTails.get(key) === current) mutationTails.delete(key);
    }
  };
  const head = async (key: string): Promise<boolean> => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      return translateError(error);
    }
  };

  return {
    ensureReady: async () => undefined,
    async createText(key, value, contentType) {
      await mutate(key, async () => {
        if (await head(key)) {
          throw new ObjectStorageError('already-exists', SAFE_MESSAGES.alreadyExists);
        }
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: value,
            ContentType: contentType,
            IfNoneMatch: '*',
          }));
        } catch (error) {
          translateError(error, true);
        }
      });
    },
    async replaceText(key, value, contentType) {
      await mutate(key, async () => {
        if (!await head(key)) {
          throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
        }
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: value,
            ContentType: contentType,
          }));
        } catch (error) {
          translateError(error);
        }
      });
    },
    async getText(key) {
      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })) as ObjectResponse;
        return await bodyToString(response.Body);
      } catch (error) {
        return translateError(error);
      }
    },
    async createBytes(key, value, contentType) {
      await mutate(key, async () => {
        if (await head(key)) {
          throw new ObjectStorageError('already-exists', SAFE_MESSAGES.alreadyExists);
        }
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: value,
            ContentType: contentType,
            IfNoneMatch: '*',
          }));
        } catch (error) {
          translateError(error, true);
        }
      });
    },
    async replaceBytes(key, value, contentType) {
      await mutate(key, async () => {
        if (!await head(key)) {
          throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
        }
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: value,
            ContentType: contentType,
          }));
        } catch (error) {
          translateError(error);
        }
      });
    },
    async getBytes(key): Promise<BinaryObjectResult> {
      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })) as BinaryObjectResponse;
        return await readBoundedBytes(response);
      } catch (error) {
        return translateError(error);
      }
    },
    exists: head,
    async delete(key) {
      await mutate(key, async () => {
        if (!await head(key)) {
          throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
        }
        try {
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        } catch (error) {
          translateError(error);
        }
      });
    },
    async listKeys(prefix, options): Promise<ObjectListResult> {
      try {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          MaxKeys: boundedLimit(options?.limit),
        })) as ListResponse;
        return {
          keys: (response.Contents ?? [])
            .map((object) => object.Key)
            .filter((key): key is string => typeof key === 'string'),
          truncated: response.IsTruncated === true,
        };
      } catch (error) {
        return translateError(error);
      }
    },
  };
}

export function createLazyGarageObjectStorage(raw: RawEnv = process.env): BinaryObjectStorage {
  let storage: BinaryObjectStorage | undefined;
  const getStorage = (): BinaryObjectStorage => {
    storage ??= createGarageObjectStorage(readGarageConfig(raw));
    return storage;
  };

  return {
    ensureReady: async () => {
      await getStorage().ensureReady?.();
    },
    createText: (key, value, contentType) => getStorage().createText(key, value, contentType),
    replaceText: (key, value, contentType) => getStorage().replaceText(key, value, contentType),
    getText: (key) => getStorage().getText(key),
    exists: (key) => getStorage().exists(key),
    delete: (key) => getStorage().delete(key),
    listKeys: (prefix, options) => getStorage().listKeys(prefix, options),
    createBytes: (key, value, contentType) =>
      getStorage().createBytes(key, value, contentType),
    replaceBytes: (key, value, contentType) =>
      getStorage().replaceBytes(key, value, contentType),
    getBytes: (key) => getStorage().getBytes(key),
  };
}
