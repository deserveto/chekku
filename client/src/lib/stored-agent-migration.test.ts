import { describe, expect, it } from 'vitest';
import {
  storedAgentMigrationTarget,
  storedAgentModelId,
} from './stored-agent-migration';

const registry = {
  defaultModel: 'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
  models: [
    'openai-compatible/gateway/qwen3.6-35b-a3b-fast',
    'openai-compatible/gateway/qwen3.6-35b-a3b',
  ],
};

describe('stored agent gateway migration', () => {
  it('migrates a legacy provider model that is allowed by the endpoint', () => {
    expect(storedAgentMigrationTarget({
      id: 'legacy-qwen',
      name: 'Legacy Qwen',
      source: 'stored',
      model: { provider: 'legacy-provider', name: 'qwen3.6-35b-a3b' },
    }, registry)).toBe('openai-compatible/gateway/qwen3.6-35b-a3b');
  });

  it('replaces a stale or disallowed model with the server default', () => {
    expect(storedAgentMigrationTarget({
      id: 'legacy-tencent',
      name: 'Legacy Tencent',
      source: 'stored',
      model: { provider: 'legacy-provider', name: 'legacy/model' },
    }, registry)).toBe('openai-compatible/gateway/qwen3.6-35b-a3b-fast');

    expect(storedAgentMigrationTarget({
      id: 'canonical-but-stale',
      name: 'Canonical stale',
      source: 'stored',
      model: { provider: 'openai-compatible', name: 'gateway/legacy/model' },
    }, registry)).toBe('openai-compatible/gateway/qwen3.6-35b-a3b-fast');
  });

  it('does not rewrite an allowed canonical model or a code agent', () => {
    expect(storedAgentMigrationTarget({
      id: 'current',
      name: 'Current',
      source: 'stored',
      model: { provider: 'openai-compatible', name: 'gateway/qwen3.6-35b-a3b' },
    }, registry)).toBeUndefined();

    expect(storedAgentMigrationTarget({
      id: 'main-agent',
      name: 'Main',
      source: 'code',
      model: { provider: 'legacy-provider', name: 'legacy/model' },
    }, registry)).toBeUndefined();
  });

  it('reconstructs the full model id from a summary', () => {
    expect(storedAgentModelId({ provider: 'legacy-provider', name: 'team/model-a' }))
      .toBe('legacy-provider/team/model-a');
  });
});
