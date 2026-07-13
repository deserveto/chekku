import { describe, expect, it, vi } from 'vitest';
import {
  discoverOpenAICompatibleModels,
  fallbackModelIds,
} from './openai-compatible-discovery.js';

describe('OpenAI-compatible model discovery', () => {
  it('reads OpenAI-compatible /models data and sends bearer auth', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'model-a' }, { id: 'team/model-b' }],
    }), { status: 200 }));

    await expect(discoverOpenAICompatibleModels({
      baseUrl: 'https://gateway.example/v1/',
      apiKey: 'secret',
      defaultModel: 'fallback',
      curatedModels: [],
      fetchImpl: request,
    })).resolves.toEqual(['model-a', 'team/model-b']);

    expect(request).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
  });

  it('falls back to curated models and then the default model', async () => {
    const request = vi.fn(async () => new Response('unavailable', { status: 503 }));

    await expect(discoverOpenAICompatibleModels({
      baseUrl: 'http://localhost:4000/v1',
      apiKey: 'key',
      defaultModel: 'default-model',
      curatedModels: ['model-a', 'model-a', 'model-b'],
      fetchImpl: request,
    })).resolves.toEqual(['model-a', 'model-b', 'default-model']);
  });

  it('builds a deterministic de-duplicated fallback list', () => {
    expect(fallbackModelIds(['model-a', 'model-a'], 'model-b')).toEqual([
      'model-a',
      'model-b',
    ]);
  });
});
