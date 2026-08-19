import { describe, expect, it } from 'vitest';

import { extractImageUrl } from './tool-result';

describe('extractImageUrl', () => {
  it('reads imageUrl from a generate_image tool result', () => {
    const result = {
      postId: 'smp_20260713120000_00000001',
      assetId: 'sva_abc',
      objectKey: 'social-posts/smp_x/visuals/sva_abc.png',
      imageUrl: '/api/storage/social-posts/smp_x/visuals/sva_abc',
      mimeType: 'image/png',
      model: 'gemini-3.1-flash-image',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(extractImageUrl(result)).toBe(
      '/api/storage/social-posts/smp_x/visuals/sva_abc',
    );
  });

  it('reads the first asset url from visualAssets metadata', () => {
    const result = {
      visualAssets: [
        { assetId: 'sva_1', imageUrl: '/api/storage/social-posts/smp_x/visuals/sva_1' },
        { assetId: 'sva_2', imageUrl: '/api/storage/social-posts/smp_x/visuals/sva_2' },
      ],
    };

    expect(extractImageUrl(result)).toBe(
      '/api/storage/social-posts/smp_x/visuals/sva_1',
    );
  });

  it('accepts url or image aliases', () => {
    expect(extractImageUrl({ url: 'https://example.com/a.png' })).toBe(
      'https://example.com/a.png',
    );
    expect(extractImageUrl({ image: 'https://example.com/b.png' })).toBe(
      'https://example.com/b.png',
    );
  });

  it('returns null for results without an image', () => {
    expect(extractImageUrl(null)).toBeNull();
    expect(extractImageUrl('just text')).toBeNull();
    expect(extractImageUrl({ results: ['a', 'b'] })).toBeNull();
    expect(extractImageUrl({ visualAssets: [] })).toBeNull();
  });

  it('reads imageUrl nested under subAgentToolResults (supervisor delegation)', () => {
    const delegationResult = {
      text: 'some text',
      subAgentThreadId: 'thread-1',
      subAgentResourceId: 'res-1',
      subAgentToolResults: [
        {
          toolName: 'previewImageTool',
          toolCallId: 'call-1',
          result: {
            previewId: 'prev_20260811020747_502f1260',
            imageUrl: '/api/storage/chat-previews/prev_20260811020747_502f1260.png',
            mimeType: 'image/png',
            model: 'gemini-3.1-flash-image',
          },
          args: { prompt: 'a map of indonesia' },
        },
      ],
    };

    expect(extractImageUrl(delegationResult)).toBe(
      '/api/storage/chat-previews/prev_20260811020747_502f1260.png',
    );
  });
});
