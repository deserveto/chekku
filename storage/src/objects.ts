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

export interface ObjectStorage {
  ensureReady?(): Promise<void>;
  createText(key: string, value: string, contentType?: string): Promise<void>;
  replaceText(key: string, value: string, contentType?: string): Promise<void>;
  getText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string, options?: { limit?: number }): Promise<ObjectListResult>;
}
