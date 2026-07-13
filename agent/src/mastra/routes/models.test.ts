import { describe, expect, it } from 'vitest';
import { toModelRoutePayload } from './models.js';

describe('models route payload', () => {
  it('returns canonical discovered ids and the canonical server default', () => {
    expect(toModelRoutePayload({
      configured: true,
      displayName: 'Rafiqspace LLM',
      defaultModel: 'qwen3.6-35b-a3b-fast',
      modelIds: ['qwen3.6-35b-a3b-fast', 'qwen3.6-35b-a3b'],
    })).toEqual({
      configured: true,
      displayName: 'Rafiqspace LLM',
      defaultModel: 'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
      models: [
        'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
        'openai-compatible/gateway/qwen3.6-35b-a3b',
      ],
    });
  });

  it('returns an empty registry when the endpoint is not configured', () => {
    expect(toModelRoutePayload({
      configured: false,
      displayName: 'OpenAI-compatible endpoint',
      defaultModel: '',
      modelIds: ['model-a'],
    })).toEqual({
      configured: false,
      displayName: 'OpenAI-compatible endpoint',
      defaultModel: '',
      models: [],
    });
  });
});
