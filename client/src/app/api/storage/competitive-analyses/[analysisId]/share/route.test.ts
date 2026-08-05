import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createShareLink: vi.fn(),
}));

vi.mock('@/server/competitive-analyses', () => {
  class CompetitiveAnalysisServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CompetitiveAnalysisServiceError,
    createShareLinkForUser: mocks.createShareLink,
  };
});

import { POST } from './route';

const analysisId = 'pca_20260723120000_deadbeef';

describe('POST /api/storage/competitive-analyses/[analysisId]/share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with url on success', async () => {
    mocks.createShareLink.mockResolvedValue({
      url: `/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`,
    });

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `/public/slides/${analysisId}?t=abcdef0123456789abcdef0123456789`,
    });
  });

  it('passes through service errors with their status', async () => {
    const { CompetitiveAnalysisServiceError } = await import('@/server/competitive-analyses');
    mocks.createShareLink.mockRejectedValue(
      new CompetitiveAnalysisServiceError('not-found', 404, 'Competitive analysis not found.'),
    );

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { code: 'not-found', message: 'Competitive analysis not found.' } });
  });

  it('returns 500 for non-service errors', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('boom'));

    const request = new Request('http://localhost/', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ analysisId }) });

    expect(response.status).toBe(500);
  });
});
