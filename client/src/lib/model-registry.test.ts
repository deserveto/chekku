import { describe, expect, it } from 'vitest';
import { normalizeModelRegistry } from './model-registry';

describe('model registry normalization', () => {
  it('uses the canonical server default when it is available', () => {
    expect(normalizeModelRegistry({
      configured: true,
      displayName: 'Rafiqspace LLM',
      defaultModel: 'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
      models: [
        'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
        'openai-compatible/gateway/qwen3.6-35b-a3b',
      ],
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

  it('falls back to the first model when a default is absent or invalid', () => {
    expect(normalizeModelRegistry({
      configured: true,
      defaultModel: 'missing',
      models: ['model-a', 'model-b', 'model-a'],
    }).defaultModel).toBe('model-a');
  });
});
