export type ObjectStorageErrorCode =
  | 'already-exists'
  | 'configuration'
  | 'not-found'
  | 'unavailable';

export class ObjectStorageError extends Error {
  constructor(public readonly code: ObjectStorageErrorCode, message: string) {
    super(message);
    this.name = 'ObjectStorageError';
  }
}

export interface ObjectListResult {
  keys: string[];
  truncated: boolean;
}

export interface BinaryObjectResult {
  value: Uint8Array;
  contentType?: string;
}

/**
 * Generic object storage contract. Text operations are required; binary
 * operations are optional on the interface so existing text-only implementations
 * and in-memory test doubles keep typechecking unchanged. Production adapters
 * (`createGarageObjectStorage`, `createLazyGarageObjectStorage`,
 * `createNamespacedObjectStorage`) implement all three binary methods; use
 * {@link asBinaryObjectStorage} to narrow a store to its binary capability at
 * consumption sites.
 */
export interface ObjectStorage {
  ensureReady?(): Promise<void>;
  createText(key: string, value: string, contentType?: string): Promise<void>;
  replaceText(key: string, value: string, contentType?: string): Promise<void>;
  getText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string, options?: { limit?: number }): Promise<ObjectListResult>;
  createBytes?(key: string, value: Uint8Array, contentType?: string): Promise<void>;
  replaceBytes?(key: string, value: Uint8Array, contentType?: string): Promise<void>;
  getBytes?(key: string): Promise<BinaryObjectResult>;
}

/**
 * `ObjectStorage` narrowed to require the three binary methods. Garage-backed
 * adapters always satisfy this; callers that need binary access (visual asset
 * persistence and reads) obtain it through {@link asBinaryObjectStorage}.
 */
export type BinaryObjectStorage = ObjectStorage & {
  createBytes: NonNullable<ObjectStorage['createBytes']>;
  replaceBytes: NonNullable<ObjectStorage['replaceBytes']>;
  getBytes: NonNullable<ObjectStorage['getBytes']>;
};

/**
 * Assert that a store supports binary object operations and narrow its type.
 * Throws a fixed actionable error when the store does not implement binary
 * methods; production Garage adapters always satisfy this.
 */
export function asBinaryObjectStorage(store: ObjectStorage): BinaryObjectStorage {
  if (!store.createBytes || !store.replaceBytes || !store.getBytes) {
    throw new ObjectStorageError(
      'configuration',
      'Binary object storage is not supported by this store.',
    );
  }
  return store as BinaryObjectStorage;
}
