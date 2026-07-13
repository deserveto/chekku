import { describe, expect, it } from 'vitest';
import {
  legacyStoredModelToRouterId,
  stripOpenAICompatibleRouterId,
  toOpenAICompatibleRouterId,
  toStoredModelConfig,
} from './openai-compatible-model.js';

describe('OpenAI-compatible model ids', () => {
  it('wraps an endpoint model slug in the canonical three-segment id', () => {
    expect(toOpenAICompatibleRouterId('tencent/hy3:free')).toBe(
      'openai-compatible/gateway/tencent/hy3:free',
    );
  });

  it('keeps an already canonical id stable', () => {
    expect(
      toOpenAICompatibleRouterId(
        'openai-compatible/gateway/tencent/hy3:free',
      ),
    ).toBe('openai-compatible/gateway/tencent/hy3:free');
  });

  it('preserves endpoint-native vendor prefixes', () => {
    expect(toOpenAICompatibleRouterId('openai/gpt-4o')).toBe(
      'openai-compatible/gateway/openai/gpt-4o',
    );
  });

  it('migrates a legacy stored model from its name rather than provider', () => {
    expect(legacyStoredModelToRouterId('tencent/hy3:free')).toBe(
      'openai-compatible/gateway/tencent/hy3:free',
    );
  });

  it('splits the canonical id into the stored-agent provider/name shape', () => {
    expect(toStoredModelConfig('tencent/hy3:free')).toEqual({
      provider: 'openai-compatible',
      name: 'gateway/tencent/hy3:free',
    });
  });

  it('returns the endpoint model id from canonical ids', () => {
    expect(
      stripOpenAICompatibleRouterId(
        'openai-compatible/gateway/my-team/model-a',
      ),
    ).toBe('my-team/model-a');
  });
});
