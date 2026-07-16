import { describe, expect, it } from 'vitest';
import {
  migrateStoredModelId,
  splitModelId,
  toStoredAgentPayload,
} from './agent-payload';

describe('stored-agent payload', () => {
  it('preserves endpoint-native vendor prefixes', () => {
    expect(splitModelId('openai/gpt-4o')).toEqual({
      provider: 'openai-compatible',
      name: 'gateway/openai/gpt-4o',
    });
  });

  it('filters unknown runtime ids', () => {
    expect(toStoredAgentPayload({
      id: 'demo',
      name: 'Demo',
      description: '',
      instructions: 'Help',
      model: 'model-a',
      tools: ['calculator', 'calcualtor'],
      agents: ['qa-web-agent', 'unknown'],
      memoryEnabled: true,
    })).toMatchObject({
      model: { provider: 'openai-compatible', name: 'gateway/model-a' },
      tools: { calculator: {} },
      agents: { 'qa-web-agent': {} },
      memory: { options: { lastMessages: 20 } },
    });
  });

  it('preserves all three registered studio tools and drops unknowns', () => {
    expect(toStoredAgentPayload({
      id: 'demo',
      name: 'Demo',
      description: '',
      instructions: 'Help',
      model: 'model-a',
      tools: ['calculator', 'get-current-time', 'send-email', 'mars-rover'],
      agents: [],
      memoryEnabled: true,
    })).toMatchObject({
      tools: {
        calculator: {},
        'get-current-time': {},
        'send-email': {},
      },
    });
  });

  it('disables memory without sending null', () => {
    expect(toStoredAgentPayload({
      id: 'demo',
      name: 'Demo',
      description: '',
      instructions: 'Help',
      model: 'model-a',
      tools: [],
      agents: [],
      memoryEnabled: false,
    }).memory).toEqual({
      options: { lastMessages: false },
    });
  });

  it('migrates legacy stored records using the stored model name', () => {
    expect(migrateStoredModelId({
      provider: 'legacy-provider',
      name: 'legacy/model',
    })).toBe('openai-compatible/gateway/legacy/model');
  });

  it('keeps canonical stored records stable', () => {
    expect(migrateStoredModelId({
      provider: 'openai-compatible',
      name: 'gateway/openai/gpt-4o',
    })).toBe('openai-compatible/gateway/openai/gpt-4o');
  });

  it('normalizes bare and canonical ids to one stored gateway', () => {
    expect(splitModelId('legacy/model')).toEqual({
      provider: 'openai-compatible',
      name: 'gateway/legacy/model',
    });
    expect(splitModelId('openai-compatible/gateway/legacy/model')).toEqual({
      provider: 'openai-compatible',
      name: 'gateway/legacy/model',
    });
  });
});
