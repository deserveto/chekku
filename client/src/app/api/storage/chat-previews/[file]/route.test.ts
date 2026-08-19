import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getChatPreviewForUser: vi.fn(),
}));

vi.mock('@/server/chat-previews', () => ({
  ChatPreviewError: class ChatPreviewError extends Error {
    constructor(
      readonly code: string,
      readonly status: 400 | 403 | 404 | 503,
      message: string,
    ) {
      super(message);
    }
  },
  getChatPreviewForUser: mocks.getChatPreviewForUser,
}));

import { GET } from './route';

describe('GET /api/storage/chat-previews/[file]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves preview bytes with the content type from the seam', async () => {
    mocks.getChatPreviewForUser.mockResolvedValue({
      value: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
    });

    const response = await GET(new Request('http://localhost/'), {
      params: Promise.resolve({ file: 'prev_20260808120000_abcd1234.png' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(mocks.getChatPreviewForUser).toHaveBeenCalledWith('prev_20260808120000_abcd1234.png');
  });

  it('passes through seam errors with their status', async () => {
    const { ChatPreviewError } = await import('@/server/chat-previews');
    mocks.getChatPreviewForUser.mockRejectedValue(
      new ChatPreviewError('not-found', 404, 'Preview not found.'),
    );

    const response = await GET(new Request('http://localhost/'), {
      params: Promise.resolve({ file: 'prev_20260808120000_abcd1234.png' }),
    });

    expect(response.status).toBe(404);
  });

  it('returns 404 in production (dev-only gate)', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await GET(new Request('http://localhost/'), {
        params: Promise.resolve({ file: 'prev_20260808120000_abcd1234.png' }),
      });
      expect(response.status).toBe(404);
      expect(mocks.getChatPreviewForUser).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
