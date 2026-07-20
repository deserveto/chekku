import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn<() => Promise<string | null>>(),
  rootStoreFactory: vi.fn(),
}));

vi.mock('@/server/auth', () => ({
  getUserId: mocks.getUserId,
}));
vi.mock('./auth', () => ({
  getUserId: mocks.getUserId,
}));

vi.mock('@chekku/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chekku/storage')>();
  return {
    ...actual,
    createLazyGarageObjectStorage: mocks.rootStoreFactory,
  };
});

vi.mock('@/server/social-posts', async () => import('./social-posts'));

import {
  ObjectStorageError,
  type ObjectStorage,
  type SocialPostMetadata,
  type SocialPostReadResult,
} from '@chekku/storage';

import { GET as getPostRoute } from '../app/api/storage/social-posts/[postId]/route';
import { GET as listPostsRoute } from '../app/api/storage/social-posts/route';
import {
  getSocialPostForUser,
  listSocialPostsForUser,
  SocialPostServiceError,
} from './social-posts';

const NAMESPACE = `agents/${Buffer.from('social-media-agent').toString('base64url')}`;
const postId = 'smp_20260714120000_deadbeef';
const metadata: SocialPostMetadata = {
  postId,
  createdAt: '2026-07-14T12:00:00.000Z',
  platform: 'instagram',
  topic: 'Hari Guru Nasional',
  specialDay: 'Hari Guru Nasional',
  status: 'DRAFT',
  postObjectKey: `social-posts/${postId}/post.md`,
  briefObjectKey: `social-posts/${postId}/brief.md`,
  metadataObjectKey: `social-posts/${postId}/metadata.json`,
};
const post: SocialPostReadResult = {
  postId,
  postMarkdown: '# Caption',
  briefMarkdown: '# Brief',
  metadata,
};

function createRootStore(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    createText: vi.fn(),
    replaceText: vi.fn(),
    getText: vi.fn(),
    exists: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(async () => ({ keys: [], truncated: false })),
    ...overrides,
  };
}

describe('social post server service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('rejects missing identity before creating storage', async () => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const listPosts = vi.fn(async () => [metadata]);

    await expect(listSocialPostsForUser({
      getServerUserId: async () => null,
      rootStoreFactory,
      listPosts,
    })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Authentication is required.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(listPosts).not.toHaveBeenCalled();
  });

  it.each([
    'smp_x',
    'smp_-',
    'smp_20260714120000_DEADBEEF',
    'smp_20260714120000_deadbeef_extra',
    '../secret',
    `smp_20260714120000_deadbeef%2Fsecret`,
    `smp_20260714120000_deadbeef%5Csecret`,
  ])('rejects malformed post ID %s before resolving storage', async (malformedPostId) => {
    const rootStoreFactory = vi.fn(() => createRootStore());
    const getPost = vi.fn(async () => post);

    await expect(getSocialPostForUser(malformedPostId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory,
      getPost,
    })).rejects.toMatchObject({
      code: 'invalid-post-id',
      status: 400,
      message: 'Invalid social post id.',
    });
    expect(rootStoreFactory).not.toHaveBeenCalled();
    expect(getPost).not.toHaveBeenCalled();
  });

  it('lists posts through social-media-agent-namespaced injected root storage', async () => {
    const listKeys = vi.fn(async () => ({ keys: [], truncated: false }));
    const root = createRootStore({ listKeys });

    await expect(listSocialPostsForUser({
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      listPosts: async (store) => {
        await store.listKeys('social-posts/');
        return [metadata];
      },
    })).resolves.toEqual([metadata]);
    expect(listKeys).toHaveBeenCalledWith(`${NAMESPACE}/social-posts/`, undefined);
  });

  it('reads posts through social-media-agent-namespaced injected root storage', async () => {
    const getText = vi.fn(async () => 'content');
    const root = createRootStore({ getText });

    await expect(getSocialPostForUser(postId, {
      getServerUserId: async () => 'user-1',
      rootStoreFactory: () => root,
      getPost: async (store, id) => {
        await store.getText(`social-posts/${id}/post.md`);
        return post;
      },
    })).resolves.toEqual(post);
    expect(getText).toHaveBeenCalledWith(`${NAMESPACE}/social-posts/${postId}/post.md`);
  });

  it.each([
    ['not-found', 'not-found', 404, 'Social post not found.'],
    ['configuration', 'storage-unavailable', 503, 'Social post storage is unavailable.'],
    ['unavailable', 'storage-unavailable', 503, 'Social post storage is unavailable.'],
    ['already-exists', 'storage-unavailable', 503, 'Social post storage is unavailable.'],
  ] as const)('maps ObjectStorageError %s without leaking provider details', async (
    storageCode,
    serviceCode,
    status,
    message,
  ) => {
    const providerDetail = 'private endpoint request-id=secret';
    let failure: unknown;

    try {
      await getSocialPostForUser(postId, {
        getServerUserId: async () => 'user-1',
        rootStoreFactory: () => createRootStore(),
        getPost: async () => {
          throw new ObjectStorageError(storageCode, providerDetail);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SocialPostServiceError);
    expect(failure).toMatchObject({ code: serviceCode, status, message });
    expect(String(failure)).not.toContain(providerDetail);
  });
});

describe('social post API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('returns authenticated post lists from default social-media-agent-namespaced storage', async () => {
    const listKeys = vi.fn(async () => ({
      keys: [`${NAMESPACE}/${metadata.metadataObjectKey}`],
      truncated: false,
    }));
    const getText = vi.fn(async () => JSON.stringify(metadata));
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ listKeys, getText }));

    const response = await listPostsRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ posts: [metadata] });
    expect(listKeys).toHaveBeenCalledWith(`${NAMESPACE}/social-posts/`, undefined);
  });

  it('does not expose hostile stored metadata fields through list or detail APIs', async () => {
    const hostileMetadata = {
      ...metadata,
      postUrl: 'https://attacker.example/post',
      physicalObjectKey: `${NAMESPACE}/private`,
      nested: { arbitrary: ['secret'] },
    };
    const listKeys = vi.fn(async () => ({
      keys: [`${NAMESPACE}/${metadata.metadataObjectKey}`],
      truncated: false,
    }));
    const getText = vi.fn(async (key: string) => key.endsWith('metadata.json')
      ? JSON.stringify(hostileMetadata)
      : key.endsWith('post.md') ? post.postMarkdown : post.briefMarkdown);
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ listKeys, getText }));

    const listResponse = await listPostsRoute();
    const detailResponse = await getPostRoute(new Request('http://localhost'), {
      params: Promise.resolve({ postId }),
    });

    await expect(listResponse.json()).resolves.toEqual({ posts: [metadata] });
    await expect(detailResponse.json()).resolves.toEqual(post);
  });

  it('returns post detail', async () => {
    const getText = vi.fn(async (key: string) => key.endsWith('metadata.json')
      ? JSON.stringify(metadata)
      : key.endsWith('post.md') ? post.postMarkdown : post.briefMarkdown);
    mocks.rootStoreFactory.mockReturnValue(createRootStore({ getText }));

    const response = await getPostRoute(new Request('http://localhost'), {
      params: Promise.resolve({ postId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(post);
  });

  it('returns forbidden before resolving storage', async () => {
    mocks.getUserId.mockResolvedValue(null);

    const response = await listPostsRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'forbidden', message: 'Authentication is required.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it.each([
    'smp_x',
    'smp_-',
    'smp_20260714120000_DEADBEEF',
    'smp_20260714120000_deadbeef_extra',
    '../secret',
    `smp_20260714120000_deadbeef%2Fsecret`,
    `smp_20260714120000_deadbeef%5Csecret`,
  ])('returns 400 for malformed post ID %s before resolving storage', async (malformedPostId) => {
    const response = await getPostRoute(new Request('http://localhost'), {
      params: Promise.resolve({ postId: malformedPostId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid-post-id', message: 'Invalid social post id.' },
    });
    expect(mocks.rootStoreFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 404, 'not-found', 'Social post not found.'],
    ['configuration', 503, 'storage-unavailable', 'Social post storage is unavailable.'],
  ] as const)('maps storage %s safely', async (storageCode, status, code, message) => {
    const providerDetail = 'bucket=https://private request-id=secret';
    mocks.rootStoreFactory.mockReturnValue(createRootStore({
      getText: vi.fn(async () => { throw new ObjectStorageError(storageCode, providerDetail); }),
    }));

    const response = await getPostRoute(new Request('http://localhost'), {
      params: Promise.resolve({ postId }),
    });
    const body = await response.text();

    expect(response.status).toBe(status);
    expect(JSON.parse(body)).toEqual({ error: { code, message } });
    expect(body).not.toContain(providerDetail);
  });

  it('returns safe 500 for unknown failures', async () => {
    const providerDetail = 'raw provider failure';
    mocks.rootStoreFactory.mockImplementation(() => { throw new Error(providerDetail); });

    const response = await listPostsRoute();
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { code: 'internal-error', message: 'Could not load social posts.' },
    });
    expect(body).not.toContain(providerDetail);
  });
});
