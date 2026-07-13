import { describe, expect, it } from 'vitest';
import {
  getConfiguredModelIds,
  getModelDisplayName,
  getServerModel,
  isModelConfigured,
} from '../model.js';

const configured = {
  LLM_BASE_URL: 'http://localhost:4000/v1',
  LLM_API_KEY: 'secret',
  LLM_DEFAULT_MODEL: 'model-a',
  LLM_DISPLAY_NAME: 'LiteLLM',
  LLM_MODELS: 'model-a,team/model-b',
};

describe('server model configuration', () => {
  it('uses the custom gateway router id for built-in agents', () => {
    expect(getServerModel(configured)).toBe(
      'openai-compatible/gateway/model-a',
    );
  });

  it('returns canonical model ids for the model registry', () => {
    expect(getConfiguredModelIds(configured)).toEqual([
      'openai-compatible/gateway/model-a',
      'openai-compatible/gateway/team/model-b',
    ]);
  });

  it('requires base URL, API key, and default model', () => {
    expect(isModelConfigured(configured)).toBe(true);
    expect(isModelConfigured({ ...configured, LLM_API_KEY: '' })).toBe(false);
    expect(() => getServerModel({ ...configured, LLM_API_KEY: '' })).toThrow(
      'LLM_BASE_URL, LLM_API_KEY, and LLM_DEFAULT_MODEL',
    );
  });

  it('uses the neutral display name', () => {
    expect(getModelDisplayName(configured)).toBe('LiteLLM');
  });
});
