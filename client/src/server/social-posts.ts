import 'server-only';

import {
  createLazyGarageObjectStorage,
  createSocialPostStorage,
  getSocialPost,
  listSocialPosts,
  ObjectStorageError,
  type ObjectStorage,
  type SocialPostMetadata,
  type SocialPostReadResult,
} from '@chekku/storage';

import { getUserId as getServerUserId } from './auth';

const POST_ID_RE = /^smp_[0-9]{14}_[0-9a-f]{8}$/;

export type SocialPostServiceErrorCode =
  | 'forbidden'
  | 'invalid-post-id'
  | 'not-found'
  | 'storage-unavailable';

export class SocialPostServiceError extends Error {
  constructor(
    readonly code: SocialPostServiceErrorCode,
    readonly status: 400 | 403 | 404 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'SocialPostServiceError';
  }
}

export interface SocialPostServiceDependencies {
  getServerUserId?: () => Promise<string | null>;
  rootStoreFactory?: () => ObjectStorage;
  listPosts?: (store: ObjectStorage) => Promise<SocialPostMetadata[]>;
  getPost?: (store: ObjectStorage, postId: string) => Promise<SocialPostReadResult>;
}

async function requireIdentity(resolveUserId: () => Promise<string | null>): Promise<void> {
  if (!await resolveUserId()) {
    throw new SocialPostServiceError('forbidden', 403, 'Authentication is required.');
  }
}

function mapStorageError(error: ObjectStorageError): SocialPostServiceError {
  if (error.code === 'not-found') {
    return new SocialPostServiceError('not-found', 404, 'Social post not found.');
  }
  return new SocialPostServiceError(
    'storage-unavailable',
    503,
    'Social post storage is unavailable.',
  );
}

function socialStore(dependencies: SocialPostServiceDependencies): ObjectStorage {
  const rootStoreFactory = dependencies.rootStoreFactory ?? createLazyGarageObjectStorage;
  return createSocialPostStorage(rootStoreFactory());
}

export async function listSocialPostsForUser(
  dependencies: SocialPostServiceDependencies = {},
): Promise<SocialPostMetadata[]> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  try {
    return await (dependencies.listPosts ?? listSocialPosts)(socialStore(dependencies));
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}

export async function getSocialPostForUser(
  postId: string,
  dependencies: SocialPostServiceDependencies = {},
): Promise<SocialPostReadResult> {
  await requireIdentity(dependencies.getServerUserId ?? getServerUserId);
  if (!POST_ID_RE.test(postId)) {
    throw new SocialPostServiceError('invalid-post-id', 400, 'Invalid social post id.');
  }

  try {
    return await (dependencies.getPost ?? getSocialPost)(socialStore(dependencies), postId);
  } catch (error) {
    if (error instanceof ObjectStorageError) throw mapStorageError(error);
    throw error;
  }
}
