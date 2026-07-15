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
  type ObjectListResult,
  type ObjectStorage,
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
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

function translateError(error: unknown, collision = false): never {
  if (error instanceof ObjectStorageError) throw error;

  const { name, code, $metadata } = errorDetails(error);
  const status = $metadata?.httpStatusCode;
  if (collision && (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412)) {
    throw new ObjectStorageError('already-exists', SAFE_MESSAGES.alreadyExists);
  }
  if (isNotFound(error)) {
    throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
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
): ObjectStorage {
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
    },
    async replaceText(key, value, contentType) {
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
    exists: head,
    async delete(key) {
      if (!await head(key)) {
        throw new ObjectStorageError('not-found', SAFE_MESSAGES.notFound);
      }
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        translateError(error);
      }
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

export function createLazyGarageObjectStorage(raw: RawEnv = process.env): ObjectStorage {
  let storage: ObjectStorage | undefined;
  const getStorage = (): ObjectStorage => {
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
  };
}
