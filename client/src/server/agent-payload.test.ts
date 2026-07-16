import { describe, expect, it } from 'vitest';
import {
  migrateStoredModelId,
  readMcpClientIds,
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
      tools: ['calculator', 'send-email', 'calcualtor'],
      agents: ['qa-web-agent', 'unknown'],
      mcpClients: [
        'garage',
        'unknown',
        'https://example.test/mcp',
        'npx arbitrary-package',
        'API_KEY=secret',
      ],
      memoryEnabled: true,
    })).toMatchObject({
      model: { provider: 'openai-compatible', name: 'gateway/model-a' },
      tools: { calculator: {}, 'send-email': {} },
      agents: { 'qa-web-agent': {} },
      mcpClients: { garage: { tools: {} } },
      memory: { options: { lastMessages: 20 } },
    });
  });

  it('round-trips selected MCP client ids in the stored shape', () => {
    const payload = toStoredAgentPayload({
      id: 'demo',
      name: 'Demo',
      description: '',
      instructions: 'Help',
      model: 'model-a',
      tools: [],
      agents: [],
      mcpClients: ['garage'],
      memoryEnabled: true,
    });

    expect(payload.mcpClients).toEqual({ garage: { tools: {} } });
    expect(readMcpClientIds({
      ...payload.mcpClients,
      unknown: { url: 'https://example.test/mcp' },
    })).toEqual(['garage']);
  });

  it('omits MCP configuration when no capability is selected', () => {
    expect(toStoredAgentPayload({
      id: 'demo',
      name: 'Demo',
      description: '',
      instructions: 'Help',
      model: 'model-a',
      tools: [],
      agents: [],
      mcpClients: [],
      memoryEnabled: true,
    })).not.toHaveProperty('mcpClients');
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
      mcpClients: [],
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
