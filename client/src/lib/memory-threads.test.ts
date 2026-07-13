import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listMemoryThreads,
  threadGet,
  threadUpdate,
  threadDelete,
  threadListMessages,
} = vi.hoisted(() => ({
  listMemoryThreads: vi.fn(),
  threadGet: vi.fn(),
  threadUpdate: vi.fn(),
  threadDelete: vi.fn(),
  threadListMessages: vi.fn(),
}));

vi.mock('./mastra-client', () => ({
  mastraClient: {
    listMemoryThreads,
    getMemoryThread: vi.fn(() => ({
      get: threadGet,
      update: threadUpdate,
      delete: threadDelete,
      listMessages: threadListMessages,
    })),
  },
}));

import {
  listAgentThreads,
  listThreadMessages,
  removeThread,
  renameThread,
} from './memory-threads';

describe('agent-scoped memory threads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadGet.mockResolvedValue({ metadata: {} });
    threadUpdate.mockResolvedValue(undefined);
    threadDelete.mockResolvedValue(undefined);
    threadListMessages.mockResolvedValue({ messages: [] });
  });

  it('filters same-resource threads owned by other agents', async () => {
    listMemoryThreads.mockResolvedValue({
      threads: [
        { id: 'main-agent-local-user-a', title: 'Main' },
        { id: 'qa-web-agent-local-user-b', title: 'QA' },
        { id: 'main-agent-other-user-c', title: 'Foreign user' },
      ],
    });

    await expect(listAgentThreads('local-user', 'main-agent')).resolves.toEqual([
      expect.objectContaining({ id: 'main-agent-local-user-a', agentId: 'main-agent' }),
    ]);
  });

  it('rejects foreign message reads before calling Mastra', async () => {
    await expect(
      listThreadMessages('main-agent', 'qa-web-agent-local-user-b', 'local-user'),
    ).rejects.toThrow('does not belong to this agent');
    expect(threadListMessages).not.toHaveBeenCalled();
  });

  it('rejects foreign rename and delete operations', async () => {
    await expect(
      renameThread('main-agent', 'qa-web-agent-local-user-b', 'local-user', 'Title'),
    ).rejects.toThrow('does not belong to this agent');
    await expect(
      removeThread('main-agent', 'qa-web-agent-local-user-b', 'local-user'),
    ).rejects.toThrow('does not belong to this agent');
    expect(threadUpdate).not.toHaveBeenCalled();
    expect(threadDelete).not.toHaveBeenCalled();
  });
});
