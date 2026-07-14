import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { env } from '../../config/env.js';
import type { PmReportObjectStore } from './store.js';

export interface GarageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type RawEnv = Record<string, unknown>;

function readEnv(raw: RawEnv, name: string): string | undefined {
  const value = raw[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readGarageConfig(raw: RawEnv = env): GarageConfig {
  const endpoint = readEnv(raw, 'GARAGE_ENDPOINT');
  const region = readEnv(raw, 'GARAGE_REGION');
  const bucket = readEnv(raw, 'GARAGE_BUCKET');
  const accessKeyId = readEnv(raw, 'GARAGE_ACCESS_KEY_ID');
  const secretAccessKey = readEnv(raw, 'GARAGE_SECRET_ACCESS_KEY');

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Garage storage not configured. Set GARAGE_ENDPOINT, GARAGE_REGION, GARAGE_BUCKET, GARAGE_ACCESS_KEY_ID, and GARAGE_SECRET_ACCESS_KEY in agent/.env.');
  }

  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return '';
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
  throw new Error('Garage returned an unreadable object body');
}

export function createGarageReportStore(config = readGarageConfig()): PmReportObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    ensureReady: async () => undefined,
    async putText(key, value, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: value,
        ContentType: contentType,
      }));
    },
    async getText(key) {
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
      return bodyToString(response.Body);
    },
    async listText(prefix) {
      const values: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        const metadataKeys = (response.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => Boolean(key?.endsWith('/metadata.json')));
        for (const key of metadataKeys) {
          const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
          values.push(await bodyToString(object.Body));
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      return values;
    },
  };
}

export function createLazyGarageReportStore(): PmReportObjectStore {
  let store: PmReportObjectStore | undefined;
  const getStore = () => {
    store ??= createGarageReportStore();
    return store;
  };

  return {
    ensureReady: async () => {
      getStore();
    },
    putText: (key, value, contentType) => getStore().putText(key, value, contentType),
    getText: (key) => getStore().getText(key),
    listText: (prefix) => getStore().listText?.(prefix) ?? Promise.resolve([]),
  };
}
