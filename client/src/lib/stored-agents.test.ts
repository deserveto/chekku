import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock, detailsMock, getStoredAgentMock, listAgentsMock, listStoredAgentsMock, updateMock } = vi.hoisted(() => {
  const details = vi.fn();
  const update = vi.fn();

  return {
    createMock: vi.fn(),
    detailsMock: details,
    getStoredAgentMock: vi.fn(() => ({ details, update })),
    listAgentsMock: vi.fn(),
    listStoredAgentsMock: vi.fn(),
    updateMock: update,
  };
});

vi.mock('./mastra-client', () => ({
  mastraClient: {
    createStoredAgent: createMock,
    getStoredAgent: getStoredAgentMock,
    listAgents: listAgentsMock,
    listStoredAgents: listStoredAgentsMock,
  },
}));
vi.mock('@/server/agent-payload', async () =>
  import('../server/agent-payload')
);

import {
  createStoredAgent,
  getStoredAgent,
  listAllAgents,
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
  metadata?: Record<string, unknown>;
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
    iconKey: 'compass',
    metadata: { owner: 'studio' },
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
    listAgentsMock.mockResolvedValue({});
    listStoredAgentsMock.mockResolvedValue({ agents: [] });
  });

  it('creates with Web Reader selection', async () => {
    await createStoredAgent('reader-agent', form({ mcpClients: ['web-reader'] }));

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpClients: { 'web-reader': { tools: {} } },
      metadata: { owner: 'studio', chekku: { iconKey: 'compass' } },
    }));
  });

  it('hydrates a selected icon and preserves unrelated metadata for editing', async () => {
    detailsMock.mockResolvedValue(stored({
      metadata: { owner: 'studio', chekku: { iconKey: 'pen', retained: true } },
    }));

    await expect(getStoredAgent('reader-agent')).resolves.toMatchObject({
      iconKey: 'pen',
      metadata: { owner: 'studio', chekku: { iconKey: 'pen', retained: true } },
    });
  });

  it('rejects edits to every reserved code-defined agent ID', async () => {
    await expect(getStoredAgent('qa-web-agent')).rejects.toThrow(
      'qa-web-agent is code-defined and cannot be edited.',
    );
    expect(detailsMock).not.toHaveBeenCalled();
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

  it('prefers protected code-defined agents over stored ID collisions', async () => {
    listAgentsMock.mockResolvedValue({
      'qa-web-agent': {
        id: 'qa-web-agent',
        name: 'QA Web Agent',
        description: 'Protected browser agent.',
        source: 'code',
        modelList: [],
      },
    });
    listStoredAgentsMock.mockResolvedValue({
      agents: [
        stored({ id: 'qa-web-agent', name: 'Legacy collision' }),
        stored({ id: 'reader-agent', name: 'Reader Agent' }),
      ],
    });

    await expect(listAllAgents()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qa-web-agent', name: 'QA Web Agent', source: 'code' }),
      expect.objectContaining({ id: 'reader-agent', source: 'stored' }),
    ]));
    await expect(listAllAgents()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qa-web-agent', source: 'stored' }),
    ]));
  });

  it('hides the supervisor sub-agents from the catalog while keeping the supervisor', async () => {
    listAgentsMock.mockResolvedValue({
      'main-agent': {
        id: 'main-agent',
        name: 'Chekku Assistant',
        description: 'General-purpose studio entry agent.',
        source: 'code',
        modelList: [],
      },
      'social-media-supervisor-agent': {
        id: 'social-media-supervisor-agent',
        name: 'Social Media Supervisor',
        description: 'Routes social-media requests.',
        source: 'code',
        modelList: [],
      },
      'social-media-content-writer': {
        id: 'social-media-content-writer',
        name: 'Social Media Content Writer',
        description: 'Drafts captions.',
        source: 'code',
        modelList: [],
      },
      'social-media-strategist-agent': {
        id: 'social-media-strategist-agent',
        name: 'Social Media Strategist',
        description: 'Researches news.',
        source: 'code',
        modelList: [],
      },
      'visual-content-agent': {
        id: 'visual-content-agent',
        name: 'Visual Content Agent',
        description: 'Renders visuals.',
        source: 'code',
        modelList: [],
      },
    });

    const ids = (await listAllAgents()).map((agent) => agent.id);
    expect(ids).toContain('main-agent');
    expect(ids).toContain('social-media-supervisor-agent');
    expect(ids).not.toContain('social-media-content-writer');
    expect(ids).not.toContain('social-media-strategist-agent');
    expect(ids).not.toContain('visual-content-agent');
  });
});
