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

import { triggerCaptionGenerationForUser } from './social-post-caption';

const postId = 'smp_20260819120000_00000001';

function makePost(status: SocialPostMetadata['status']): SocialPostReadResult {
  return {
    postId,
    postMarkdown: '<!-- canonical-unit -->unit<!-- /canonical-unit -->',
    briefMarkdown: 'brief',
    metadata: {
      postId,
      createdAt: '2026-08-19T12:00:00.000Z',
      platform: 'instagram',
      topic: 'Hari Guru',
      status,
      postObjectKey: `social-posts/${postId}/post.md`,
      briefObjectKey: `social-posts/${postId}/brief.md`,
      metadataObjectKey: `social-posts/${postId}/metadata.json`,
    },
  };
}

describe('triggerCaptionGenerationForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue('user-1');
  });

  it('rejects missing identity before any read or trigger', async () => {
    const getPost = vi.fn();
    await expect(triggerCaptionGenerationForUser(postId, {
      getServerUserId: async () => null,
      getPost,
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(getPost).not.toHaveBeenCalled();
  });

  it('rejects a malformed post id before any read', async () => {
    const getPost = vi.fn();
    await expect(triggerCaptionGenerationForUser('smp_legacy', {
      getServerUserId: async () => 'user-1',
      getPost,
    })).rejects.toMatchObject({ code: 'invalid-post-id', status: 400 });
    expect(getPost).not.toHaveBeenCalled();
  });

  it('rejects a post that is not DRAFT (409) without starting the workflow', async () => {
    const startWorkflow = vi.fn();
    await expect(triggerCaptionGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('CANONICAL_APPROVED'),
      startWorkflow,
    })).rejects.toMatchObject({ code: 'invalid-status', status: 409 });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('starts the repurpose-social-post workflow for a DRAFT post', async () => {
    const startWorkflow = vi.fn(async () => undefined);
    await triggerCaptionGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('DRAFT'),
      startWorkflow,
    });
    expect(startWorkflow).toHaveBeenCalledWith('user-1');
  });

  it('maps a failed workflow start to a bounded 502 error', async () => {
    await expect(triggerCaptionGenerationForUser(postId, {
      getServerUserId: async () => 'user-1',
      getPost: async () => makePost('DRAFT'),
      startWorkflow: async () => {
        throw new Error('create-run failed with status 500');
      },
    })).rejects.toMatchObject({ code: 'job-trigger-failed', status: 502 });
  });
});
