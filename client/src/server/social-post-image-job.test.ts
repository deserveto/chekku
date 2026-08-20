import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn<() => Promise<string | null>>(),
  getDownstreamToken: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('./auth', () => ({
  getUserId: mocks.getUserId,
  getDownstreamToken: mocks.getDownstreamToken,
}));

import type { SocialPostMetadata, SocialPostReadResult } from '@chekku/storage';

import { startImageGenerationForUser } from './social-post-image-job';

const postId = 'smp_20260819120000_00000002';

function makePost(status: SocialPostMetadata['status']): SocialPostReadResult {
  return {
    postId,
    postMarkdown: '<!-- canonical-unit -->unit<!-- /canonical-unit -->',
    briefMarkdown: 'brief',
    captionMarkdown: 'caption',
    metadata: {
      postId,
      createdAt: '2026-08-19T12:00:00.000Z',
      platform: 'instagram',
      topic: 'Hari Guru',
      status,
      postObjectKey: `social-posts/${postId}/post.md`,
      briefObjectKey: `social-posts/${postId}/brief.md`,
      captionObjectKey: `social-posts/${postId}/caption.md`,
      metadataObjectKey: `social-posts/${postId}/metadata.json`,
    },
  };
}

describe('startImageGenerationForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('rejects missing identity before any read or trigger', async () => {
    const getPost = vi.fn();
    await expect(startImageGenerationForUser(postId, {
      getServerUserId: async () => null,
      getPost,
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(getPost).not.toHaveBeenCalled();
  });

  it('rejects a malformed post id before any read', async () => {
    const getPost = vi.fn();
    await expect(startImageGenerationForUser('../secret', {
      getServerUserId: async () => 'user-1',
      getPost,
    })).rejects.toMatchObject({ code: 'invalid-post-id', status: 400 });
    expect(getPost).not.toHaveBeenCalled();
  });

  it('rejects a post that is not CANONICAL_APPROVED (409) without starting', async () => {
    const startWorkflow = vi.fn();
    await expect(startImageGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('DRAFT'),
      startWorkflow,
    })).rejects.toMatchObject({ code: 'invalid-status', status: 409 });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('starts the generate-social-post-visual workflow for a CANONICAL_APPROVED post', async () => {
    const startWorkflow = vi.fn(async () => undefined);
    await startImageGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('CANONICAL_APPROVED'),
      startWorkflow,
    });
    expect(startWorkflow).toHaveBeenCalledWith('user-1');
  });

  it('maps a failed workflow start to a bounded 502 error', async () => {
    await expect(startImageGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('CANONICAL_APPROVED'),
      startWorkflow: async () => {
        throw new Error('start failed with status 503');
      },
    })).rejects.toMatchObject({ code: 'job-trigger-failed', status: 502 });
  });
});
