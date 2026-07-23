import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock, detailsMock, getStoredAgentMock, updateMock } = vi.hoisted(() => {
  const details = vi.fn();
  const update = vi.fn();

  return {
    createMock: vi.fn(),
    detailsMock: details,
    getStoredAgentMock: vi.fn(() => ({ details, update })),
    updateMock: update,
  };
});

vi.mock('./mastra-client', () => ({
  mastraClient: {
    createStoredAgent: createMock,
    getStoredAgent: getStoredAgentMock,
  },
}));
vi.mock('@/server/agent-payload', async () =>
  import('../server/agent-payload')
);

import {
  createStoredAgent,
  getStoredAgent,
  type AgentFormInput,
  updateStoredAgent,
} from './stored-agents';

type StoredFixture = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: { provider: string; name: string };
  memory: { options: { lastMessages: number | false } };
  tools: Record<string, Record<string, never>>;
  agents: Record<string, Record<string, never>>;
  mcpClients: Record<string, { tools: Record<string, never> }>;
  status: 'draft' | 'published' | 'archived';
  createdAt: string;
  updatedAt: string;
};

function form(overrides: Partial<AgentFormInput> = {}): AgentFormInput {
  return {
    name: 'Reader Agent',
    description: 'Reads public pages.',
    instructions: 'Read requested public pages.',
    model: 'model-a',
    tools: ['calculator'],
    agents: ['qa-web-agent'],
    mcpClients: [],
    memoryEnabled: true,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredFixture> = {}): StoredFixture {
  return {
    id: 'reader-agent',
    name: 'Reader Agent',
    description: 'Reads public pages.',
    instructions: 'Read requested public pages.',
    model: { provider: 'openai-compatible', name: 'gateway/model-a' },
    memory: { options: { lastMessages: 20 } },
    tools: { calculator: {} },
    agents: { 'qa-web-agent': {} },
    mcpClients: { garage: { tools: {} } },
    status: 'draft',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('stored-agent MCP selections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(stored());
    detailsMock.mockResolvedValue(stored());
    updateMock.mockResolvedValue(stored());
  });

  it('creates with Web Reader selection', async () => {
    await createStoredAgent('reader-agent', form({ mcpClients: ['web-reader'] }));

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpClients: { 'web-reader': { tools: {} } },
    }));
  });

  it('reads all fixed MCP selections from detail', async () => {
    detailsMock.mockResolvedValue(stored({
      mcpClients: {
        garage: { tools: {} },
        searxng: { tools: {} },
        'web-reader': { tools: {} },
      },
    }));

    await expect(getStoredAgent('reader-agent')).resolves.toMatchObject({
      mcpClients: ['garage', 'searxng', 'web-reader'],
    });
  });

  it('updates with SearXNG and Web Reader selections', async () => {
    await updateStoredAgent('reader-agent', form({
      mcpClients: ['searxng', 'web-reader'],
    }));

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpClients: {
        searxng: { tools: {} },
        'web-reader': { tools: {} },
      },
    }));
  });
});
