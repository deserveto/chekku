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
    expect(value.GARAGE_ENDPOINT).toBe('');
    expect(value.GARAGE_REGION).toBe('');
    expect(value.GARAGE_BUCKET).toBe('');
    expect(value.GARAGE_ACCESS_KEY_ID).toBe('');
    expect(value.GARAGE_SECRET_ACCESS_KEY).toBe('');
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

  it('accepts five Garage object storage values', () => {
    const value = loadEnv({
      GARAGE_ENDPOINT: 'https://garage.example.test',
      GARAGE_REGION: 'garage',
      GARAGE_BUCKET: 'chekku-objects',
      GARAGE_ACCESS_KEY_ID: 'access-key',
      GARAGE_SECRET_ACCESS_KEY: 'secret-key',
    });

    expect(value.GARAGE_ENDPOINT).toBe('https://garage.example.test');
    expect(value.GARAGE_REGION).toBe('garage');
    expect(value.GARAGE_BUCKET).toBe('chekku-objects');
    expect(value.GARAGE_ACCESS_KEY_ID).toBe('access-key');
    expect(value.GARAGE_SECRET_ACCESS_KEY).toBe('secret-key');
  });

  it('rejects invalid URLs and unsupported logging levels', () => {
    expect(() => loadEnv({ LLM_BASE_URL: 'not-a-url' })).toThrow();
    expect(() => loadEnv({ GARAGE_ENDPOINT: 'not-a-url' })).toThrow();
    expect(() => loadEnv({ LOG_LEVEL: 'trace' })).toThrow();
  });

  it('applies Maestro defaults (disabled by default)', () => {
    const value = loadEnv({});

    expect(value.MAESTRO_ENABLED).toBe('false');
    expect(value.MAESTRO_COMMAND).toBe('maestro');
    expect(value.MAESTRO_WORKSPACE).toBe('../maestro');
    expect(value.MAESTRO_ARTIFACT_DIR).toBe('../artifacts/maestro');
    expect(value.MAESTRO_TIMEOUT_MS).toBe(120000);
    expect(value.ADB_PATH).toBe('adb');
  });

  it('accepts Maestro overrides and rejects invalid enabled flags', () => {
    const value = loadEnv({
      MAESTRO_ENABLED: 'true',
      MAESTRO_COMMAND: '/usr/local/bin/maestro',
      MAESTRO_WORKSPACE: '/abs/maestro',
      MAESTRO_ARTIFACT_DIR: '/abs/artifacts/maestro',
      MAESTRO_TIMEOUT_MS: '60000',
      ADB_PATH: '/usr/local/bin/adb',
    });

    expect(value.MAESTRO_ENABLED).toBe('true');
    expect(value.MAESTRO_COMMAND).toBe('/usr/local/bin/maestro');
    expect(value.MAESTRO_TIMEOUT_MS).toBe(60000);
    expect(value.ADB_PATH).toBe('/usr/local/bin/adb');

    expect(() => loadEnv({ MAESTRO_ENABLED: 'yes' })).toThrow();
    expect(() => loadEnv({ MAESTRO_TIMEOUT_MS: '0' })).toThrow();
  });
});
