import 'server-only';

import {
  asBinaryObjectStorage,
  createLazyGarageObjectStorage,
  createNamespacedObjectStorage,
  ObjectStorageError,
  SOCIAL_MEDIA_AGENT_ID,
  type ObjectStorage,
} from '@chekku/storage';

import { getUserId } from './auth';

/**
 * Server-only read seam for chat-side image previews.
 *
 * The `preview_image` agent tool writes standalone preview images under an
 * isolated `chat-previews/` prefix in the `social-media-agent` namespace (the
 * same namespace the social-post surface uses, but a different prefix, so
 * `/social-posts` never lists them). This seam reads one preview's bytes for
 * the application-facing image route, after the same identity check the rest
 * of the storage routes apply. It never accepts an arbitrary object key from
 * a URL — the file param must be `<previewId>.<ext>` with a canonical preview
 * id and an allowlisted extension.
 */

const PREVIEW_ID_RE = /^prev_[0-9]{14}_[0-9a-f]{8}$/;
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export type ChatPreviewErrorCode =
  | 'forbidden'
  | 'invalid-file'
  | 'not-found'
  | 'storage-unavailable';

export class ChatPreviewError extends Error {
  constructor(
    readonly code: ChatPreviewErrorCode,
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'ChatPreviewError';
  }
}

export interface ChatPreviewBytes {
  value: Uint8Array;
  contentType: string;
}

export interface ChatPreviewDependencies {
  getUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
}

function parseFile(file: string): { objectKey: string; contentType: string } {
  const dot = file.lastIndexOf('.');
  if (dot <= 0) {
    throw new ChatPreviewError('invalid-file', 400, 'Invalid preview file.');
  }
  const previewId = file.slice(0, dot);
  const ext = file.slice(dot + 1).toLowerCase();
  if (!PREVIEW_ID_RE.test(previewId)) {
    throw new ChatPreviewError('invalid-file', 400, 'Invalid preview file.');
  }
  const contentType = EXT_TO_CONTENT_TYPE[ext];
  if (!contentType) {
    throw new ChatPreviewError('invalid-file', 400, 'Invalid preview file.');
  }
  return { objectKey: `chat-previews/${previewId}.${ext}`, contentType };
}

export async function getChatPreviewForUser(
  file: string,
  dependencies: ChatPreviewDependencies = {},
): Promise<ChatPreviewBytes> {
  const resolveUserId = dependencies.getUserId ?? getUserId;
  if (!(await resolveUserId())) {
    throw new ChatPreviewError('forbidden', 403, 'Authentication is required.');
  }
  const { objectKey, contentType } = parseFile(file);
  const root = (dependencies.rootStoreFactory ?? createLazyGarageObjectStorage)();
  const store = asBinaryObjectStorage(createNamespacedObjectStorage(root, SOCIAL_MEDIA_AGENT_ID));
  try {
    const result = await store.getBytes(objectKey);
    // Always serve the allowlisted extension-derived Content-Type, never the
    // stored one — a foreign/future writer storing e.g. text/html metadata
    // must not get app-origin HTML served from this route.
    return { value: result.value, contentType };
  } catch (error) {
    if (error instanceof ObjectStorageError) {
      if (error.code === 'not-found') {
        throw new ChatPreviewError('not-found', 404, 'Preview not found.');
      }
      throw new ChatPreviewError('storage-unavailable', 503, 'Preview storage is unavailable.');
    }
    throw error;
  }
}

// Exported for unit tests.
export const __testing = { parseFile };
