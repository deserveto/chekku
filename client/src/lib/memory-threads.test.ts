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
    ).resolves.toEqual([]);
  });

  it('returns an empty list when the upstream reports not-found via message', async () => {
    threadListMessages.mockRejectedValueOnce(new Error('Thread not found'));
    await expect(
      listThreadMessages('main-agent', 'main-agent-local-user-a', 'local-user'),
    ).resolves.toEqual([]);
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

  it('rebuilds tool history from Mastra Memory V2 parts on restore', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'stored-user',
          role: 'user',
          createdAt: '2026-08-18T10:00:00.000Z',
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'Check the signup form.' }],
            content: 'Check the signup form.',
          },
        },
        {
          id: 'stored-assistant',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:01.000Z',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-1',
                  toolName: 'browser_goto',
                  args: { url: 'https://example.com' },
                  result: { ok: true },
                },
              },
              { type: 'text', text: 'The page is open.' },
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-2',
                  toolName: 'browser_snapshot',
                  result: { fields: 4 },
                },
              },
              { type: 'text', text: 'All set.' },
            ],
            content: 'The page is open.\nAll set.',
          },
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: 'stored-user',
      role: 'user',
      content: 'Check the signup form.',
      createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
    });

    expect(messages[1]?.parts).toEqual([
      {
        type: 'tool',
        id: 'stored-assistant-t0',
        toolCallId: 'call-1',
        toolName: 'browser_goto',
        status: 'complete',
        args: { url: 'https://example.com' },
        result: { ok: true },
      },
      {
        type: 'text',
        id: 'stored-assistant-x1',
        content: 'The page is open.',
      },
      {
        type: 'tool',
        id: 'stored-assistant-t2',
        toolCallId: 'call-2',
        toolName: 'browser_snapshot',
        status: 'complete',
        result: { fields: 4 },
      },
      { type: 'text', id: 'stored-assistant-x3', content: 'All set.' },
    ]);
    expect(messages[1]?.content).toBe('The page is open.\nAll set.');
  });

  it('keeps an assistant turn that persisted only tool parts', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'tools-only',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:02.000Z',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-1',
                  toolName: 'browser_click',
                  result: { clicked: true },
                },
              },
            ],
          },
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('');
    expect(messages[0]?.parts).toEqual([
      {
        type: 'tool',
        id: 'tools-only-t0',
        toolCallId: 'call-1',
        toolName: 'browser_click',
        status: 'complete',
        result: { clicked: true },
      },
    ]);
  });

  it('still restores plain legacy string content without parts', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'legacy',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:03.000Z',
          content: 'Legacy stored response',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toEqual([
      {
        id: 'legacy',
        role: 'assistant',
        content: 'Legacy stored response',
        createdAt: Date.parse('2026-08-18T10:00:03.000Z'),
      },
    ]);
  });

  it('merges per-step assistant rows into a single restored turn', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'row-user',
          role: 'user',
          createdAt: '2026-08-18T10:00:00.000Z',
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'Check the signup form.' }],
            content: 'Check the signup form.',
          },
        },
        {
          id: 'row-step-1',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:01.000Z',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-1',
                  toolName: 'browser_goto',
                  args: { url: 'https://example.com' },
                  result: { ok: true },
                },
              },
            ],
          },
        },
        {
          id: 'row-step-2',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:02.000Z',
          content: {
            format: 2,
            parts: [
              { type: 'text', text: 'The page is open.' },
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'result',
                  toolCallId: 'call-2',
                  toolName: 'browser_snapshot',
                  result: { fields: 4 },
                },
              },
            ],
          },
        },
        {
          id: 'row-step-3',
          role: 'assistant',
          createdAt: '2026-08-18T10:00:03.000Z',
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'All set.' }],
          },
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    // One user turn + ONE assistant turn carrying the whole timeline.
    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe('row-step-1');
    expect(messages[1]?.createdAt).toBe(
      Date.parse('2026-08-18T10:00:01.000Z'),
    );
    expect(messages[1]?.content).toBe('The page is open.\nAll set.');
    expect(
      messages[1]?.parts?.map((part) =>
        part.type === 'tool' ? part.toolName : 'text',
      ),
    ).toEqual(['browser_goto', 'text', 'browser_snapshot', 'text']);
  });

  it('restores legacy V1 tool-call parts with outcomes merged from tool rows', async () => {
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

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages.map((m) => m.id)).toEqual(['msg-user', 'msg-asst']);
    expect(messages[1]?.content).toBe('Delegating…');
    expect(messages[1]?.parts).toHaveLength(2);
    expect(messages[1]?.parts?.[1]).toMatchObject({
      type: 'tool',
      toolCallId: 'call_1',
      toolName: 'search_web',
      status: 'complete',
      args: { query: 'local-first db' },
      result: { results: ['a', 'b'] },
    });
  });

  it('keeps a legacy V1 assistant message whose only body is a tool call', async () => {
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

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('');
    expect(messages[0]?.parts?.[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call_1',
      status: 'interrupted',
      args: {},
    });
  });

  it('marks a restored V1 tool call as error when the outcome is an error variant', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'browser_click',
              input: { selector: '#go' },
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
              output: { type: 'error-text', value: 'selector not found' },
            },
          ],
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages[0]?.parts?.[0]).toMatchObject({
      status: 'error',
      result: 'selector not found',
    });
  });

  it('restores a sub-agent delegation invocation with nested tool results intact', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-user',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'Cari berita' }] },
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-asst',
          role: 'assistant',
          content: {
            format: 2,
            content: 'Hasil riset…',
            parts: [
              { type: 'step-start' },
              { type: 'text', text: 'Hasil riset…' },
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call_strategist',
                  toolName: 'agent-socialMediaStrategistAgent',
                  args: { prompt: 'Cari berita teknologi terbaru' },
                  state: 'result',
                  result: {
                    text: 'Content pillar: TECHNOLOGY & AI TRENDS',
                    subAgentThreadId: 'thread-strategist',
                    subAgentResourceId: 'user-socialMediaStrategistAgent',
                    subAgentToolResults: [
                      {
                        toolName: 'search_web',
                        toolCallId: 'chatcmpl-tool-95a456ca49c13702',
                        result: {
                          query: 'berita teknologi AI',
                          results: [{ url: 'https://mediaindonesia.com/x', title: 'AI' }],
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe('Hasil riset…');
    const delegation = messages[1]?.parts?.find(
      (part) => part.type === 'tool',
    );
    expect(delegation).toMatchObject({
      toolCallId: 'call_strategist',
      toolName: 'agent-socialMediaStrategistAgent',
      status: 'complete',
    });
    const nested = (delegation as { result?: { subAgentToolResults?: Array<{ result?: { results?: unknown[] } }> } })
      .result?.subAgentToolResults ?? [];
    expect(nested[0]?.result?.results).toHaveLength(1);
  });

  it('keeps a V2 tool-only delegation message and preserves the nested chat-preview image URL', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call_visual',
                  toolName: 'agent-visualContentAgent',
                  args: { postId: 'smp_1' },
                  state: 'result',
                  result: {
                    text: 'Visual generated.',
                    subAgentToolResults: [
                      {
                        toolName: 'generate_image',
                        toolCallId: 'call_gen',
                        result: {
                          imageUrl:
                            '/api/storage/chat-previews/prev_20260815121042_1d47453e.png',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('');
    const tool = messages[0]?.parts?.[0];
    expect(tool).toMatchObject({
      type: 'tool',
      toolCallId: 'call_visual',
      toolName: 'agent-visualContentAgent',
      status: 'complete',
    });
    const nested = (tool as { result?: { subAgentToolResults?: Array<{ result?: { imageUrl?: string } }> } })
      .result?.subAgentToolResults ?? [];
    expect(nested[0]?.result?.imageUrl).toBe(
      '/api/storage/chat-previews/prev_20260815121042_1d47453e.png',
    );
  });

  it('maps a V2 output-error invocation to an error part', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call_err',
                  toolName: 'generate_image',
                  args: { prompt: 'x' },
                  state: 'output-error',
                  errorText: 'Image generation is not configured',
                },
              },
            ],
          },
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages[0]?.parts?.[0]).toMatchObject({
      toolCallId: 'call_err',
      status: 'error',
      result: 'Image generation is not configured',
    });
  });

  it('marks a still-running V2 invocation as interrupted on restore', async () => {
    threadListMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-asst',
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  toolCallId: 'call_pending',
                  toolName: 'search_web',
                  args: { query: 'ai' },
                  state: 'call',
                },
              },
            ],
          },
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const messages = await listThreadMessages(
      'main-agent',
      'main-agent-local-user-a',
      'local-user',
    );

    expect(messages[0]?.parts?.[0]).toMatchObject({
      toolCallId: 'call_pending',
      status: 'interrupted',
    });
    expect(
      (messages[0]?.parts?.[0] as { result?: unknown }).result,
    ).toBeUndefined();
  });
});
