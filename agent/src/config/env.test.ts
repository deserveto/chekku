import { describe, expect, it } from 'vitest';

import { loadEnv } from './env.js';

describe('env config', () => {
  it('uses neutral OpenAI-compatible defaults', () => {
    const value = loadEnv({});

    expect(value.LLM_BASE_URL).toBe('');
    expect(value.LLM_API_KEY).toBe('');
    expect(value.LLM_DEFAULT_MODEL).toBe('');
    expect(value.LLM_DISPLAY_NAME).toBe('OpenAI-compatible endpoint');
    expect(value.LLM_MODELS).toBe('');
    expect(value.CHEKKU_DEFAULT_AGENT_ID).toBe('main-agent');
  });

  it('accepts the Rafiqspace OpenAI-compatible server configuration', () => {
    const value = loadEnv({
      LLM_BASE_URL: 'https://llm.rafiqspace.ai/v1',
      LLM_API_KEY: 'secret',
      LLM_DEFAULT_MODEL: 'qwen3.6-35b-a3b-fast',
      LLM_DISPLAY_NAME: 'Rafiqspace LLM',
      LLM_MODELS: 'qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b',
    });

    expect(value.LLM_BASE_URL).toBe('https://llm.rafiqspace.ai/v1');
    expect(value.LLM_API_KEY).toBe('secret');
    expect(value.LLM_DEFAULT_MODEL).toBe('qwen3.6-35b-a3b-fast');
    expect(value.LLM_DISPLAY_NAME).toBe('Rafiqspace LLM');
  });

  it('ignores unrelated environment variables', () => {
    const value = loadEnv({
      UNUSED_EXPERIMENTAL_SETTING: 'ignored',
    });

    expect(value.LLM_BASE_URL).toBe('');
    expect(value.LLM_API_KEY).toBe('');
    expect(value.LLM_DEFAULT_MODEL).toBe('');
  });

  it('rejects invalid URLs and unsupported logging levels', () => {
    expect(() => loadEnv({ LLM_BASE_URL: 'not-a-url' })).toThrow();
    expect(() => loadEnv({ LOG_LEVEL: 'trace' })).toThrow();
  });
});
