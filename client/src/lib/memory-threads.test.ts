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

  it('treats an already-absent thread as a successful deletion', async () => {
    threadDelete.mockRejectedValueOnce(
      Object.assign(new Error('HTTP error! status: 404 - {"error":"Thread not found"}'), {
        status: 404,
      }),
    );

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).resolves.toBeUndefined();
    expect(threadDelete).toHaveBeenCalledTimes(1);
  });

  it('accepts the upstream thread-not-found message when no status is available', async () => {
    threadDelete.mockRejectedValueOnce(new Error('Thread not found'));

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).resolves.toBeUndefined();
    expect(threadDelete).toHaveBeenCalledTimes(1);
  });

  it('re-throws deletion errors other than thread-not-found', async () => {
    threadDelete.mockRejectedValueOnce(
      Object.assign(new Error('Server error'), { status: 500 }),
    );

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Server error');
  });

  it('does not let a thread-not-found message override an explicit non-404 status', async () => {
    threadDelete.mockRejectedValueOnce(
      Object.assign(new Error('Thread not found'), { status: 500 }),
    );

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Thread not found');
  });

  it('does not treat an unrelated not-found message as a missing thread', async () => {
    threadDelete.mockRejectedValueOnce(new Error('Search index not found'));

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Search index not found');
  });

  it('does not swallow an extended status-less deletion error', async () => {
    threadDelete.mockRejectedValueOnce(
      new Error('Thread not found while storage is unavailable'),
    );

    await expect(
      removeThread('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Thread not found while storage is unavailable');
  });

  it('rejects a rename when the thread is already absent', async () => {
    threadGet.mockRejectedValueOnce(
      Object.assign(new Error('Thread not found'), { status: 404 }),
    );

    await expect(
      renameThread(
        'main-agent',
        'main-agent-local-user-a',
        'local-user',
        'New title',
      ),
    ).rejects.toThrow('Thread not found');
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it('returns an empty list when the thread does not exist yet (upstream 404 status)', async () => {
    threadListMessages.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with 404'), { status: 404 }),
    );
    await expect(
      listThreadMessages('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).resolves.toEqual({ messages: [], toolEvents: [] });
  });

  it('returns an empty list when the upstream reports not-found via message', async () => {
    threadListMessages.mockRejectedValueOnce(new Error('Thread not found'));
    await expect(
      listThreadMessages('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).resolves.toEqual({ messages: [], toolEvents: [] });
  });

  it('re-throws an extended status-less message-read error', async () => {
    threadListMessages.mockRejectedValueOnce(
      new Error('Thread not found while storage is unavailable'),
    );
    await expect(
      listThreadMessages('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Thread not found while storage is unavailable');
  });

  it('re-throws errors that are not thread-not-found', async () => {
    threadListMessages.mockRejectedValueOnce(
      Object.assign(new Error('Server error'), { status: 500 }),
    );
    await expect(
      listThreadMessages('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).rejects.toThrow('Server error');
  });

  it('restores tool-call and tool-result parts as tool events', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: [{ type: 'text', text: 'draft a post' }],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-asst',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Delegating…' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'search_web',
              input: { query: 'local-first db' },
            },
          ],
          createdAt: '2024-01-01T00:00:01.000Z',
        },
        {
          id: 'msg-tool',
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'search_web',
              output: { type: 'json', value: { results: ['a', 'b'] } },
            },
          ],
          createdAt: '2024-01-01T00:00:02.000Z',
        },
      ],
    });

    const result = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(result.messages.map((m) => m.id)).toEqual([
      'msg-user',
      'msg-asst',
    ]);
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        id: 'call_1',
        toolCallId: 'call_1',
        messageId: 'msg-asst',
        toolName: 'search_web',
        status: 'complete',
        args: { query: 'local-first db' },
        result: { results: ['a', 'b'] },
      }),
    ]);
  });

  it('keeps an assistant message whose only body is a tool call', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'get_current_time',
              input: {},
            },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const result = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('');
    expect(result.toolEvents[0]!.messageId).toBe('msg-asst');
  });

  it('marks restored tool events as error when the result is an error variant', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'generate_image',
              input: { prompt: 'x' },
            },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-tool',
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'generate_image',
              output: { type: 'error-text', value: 'Not configured' },
            },
          ],
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      ],
    });

    const result = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(result.toolEvents[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        result: 'Not configured',
      }),
    );
  });
});
