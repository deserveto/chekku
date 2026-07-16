'use client';

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { RequestContext } from '@mastra/client-js';
import { useRouter } from 'next/navigation';
import { MarkdownMessage } from '@/components/markdown-message';
import { ResizableSidebar } from '@/components/studio/resizable-sidebar';
import { BrandMark } from '@/components/ui/brand-mark';
import { buildChatHref } from '@/lib/chat-route';
import {
  listAgentThreads,
  listThreadMessages,
  removeThread,
  renameThread,
  type StudioThread,
} from '@/lib/memory-threads';
import { mastraClient } from '@/lib/mastra-client';
import { loadModelRegistry } from '@/lib/model-registry';
import {
  ensureStoredAgentUsesServerGateway,
  listAllAgents,
} from '@/lib/stored-agents';
import {
  createOwnedThreadId,
  isOwnedThreadId,
} from '@/lib/thread-id';
import {
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolEvent,
} from '@/lib/types';

const ACCESS_MODE_KEY = 'chekku-browser-access';

function readChunkPayload(chunk: unknown): Record<string, unknown> {
  if (!chunk || typeof chunk !== 'object') return {};

  const payload = (chunk as Record<string, unknown>).payload;
  return payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {};
}

function safeDisplay(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageFromMemory(
  value: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
  },
): ChatMessage {
  return { ...value };
}

type ChekkuAgentClient = ReturnType<typeof mastraClient.getAgent>;

interface ApprovalResumeResult {
  text: string;
  toolResult?: { result?: unknown; output?: unknown };
}

/**
 * Resume a suspended tool-approval run with the non-streaming generate
 * variants and return the completed run's final text + matching tool result.
 *
 * The streaming resume (`approveToolCall`/`declineToolCall`) emits a
 * tool-result chunk without a preceding tool-call chunk, which makes
 * `@mastra/client-js`'s stream pipeline throw "tool_result must be preceded by
 * a tool_call". The generate variants sidestep that by returning the whole
 * completed run in a single response. Kept at module scope so it stays out of
 * the component's render purity analysis.
 */
async function resumeApprovalGenerate(
  agent: ChekkuAgentClient,
  runId: string,
  toolCallId: string,
  approved: boolean,
  requestContext: RequestContext,
): Promise<ApprovalResumeResult> {
  const result = approved
    ? await agent.approveToolCallGenerate({ runId, toolCallId, requestContext })
    : await agent.declineToolCallGenerate({ runId, toolCallId, requestContext });

  const output = (result ?? {}) as {
    text?: string;
    toolResults?: Array<{
      toolCallId?: string;
      result?: unknown;
      output?: unknown;
    }>;
  };

  return {
    text: (output.text ?? '').trim(),
    toolResult: output.toolResults?.find(
      (item) => item?.toolCallId === toolCallId,
    ),
  };
}

export function ChatStudio({
  resourceId,
  initialAgentId,
  initialThreadId,
}: {
  resourceId: string;
  initialAgentId: string;
  initialThreadId: string;
}) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [threads, setThreads] = useState<StudioThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const [modelReady, setModelReady] = useState(false);
  const [accessMode, setAccessMode] = useState<'approval' | 'full'>(
    'approval',
  );

  const agentId = initialAgentId;
  const threadId = initialThreadId;
  const agent = mastraClient.getAgent(agentId);

  const currentAgent = agents.find((entry) => entry.id === agentId);
  const threadOwned = isOwnedThreadId(threadId, agentId, resourceId);

  const filteredThreads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) =>
      thread.title.toLowerCase().includes(needle),
    );
  }, [search, threads]);

  const requestContext = useCallback(() => {
    const context = new RequestContext();
    context.set('browserAccess', accessMode);
    return context;
  }, [accessMode]);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await listAgentThreads(resourceId, agentId));
    } catch {
      setThreads([]);
    }
  }, [agentId, resourceId]);

  useEffect(() => {
    const saved = window.localStorage.getItem(ACCESS_MODE_KEY);
    if (saved !== 'full') return;

    const frame = window.requestAnimationFrame(() => {
      setAccessMode('full');
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(ACCESS_MODE_KEY, accessMode);
  }, [accessMode]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(undefined);

      try {
        const [agentList, modelRegistry] = await Promise.all([
          listAllAgents(),
          loadModelRegistry(),
        ]);

        if (cancelled) return;

        const selectedAgent = agentList.find((entry) => entry.id === agentId);
        if (selectedAgent) {
          await ensureStoredAgentUsesServerGateway(
            selectedAgent,
            modelRegistry,
          );
        }

        if (cancelled) return;
        setAgents(agentList);
        setModelReady(modelRegistry.configured);

        await refreshThreads();

        try {
          const storedMessages = await listThreadMessages(
            agentId,
            threadId,
            resourceId,
          );
          if (!cancelled) {
            setMessages(storedMessages.map(messageFromMemory));
          }
        } catch {
          if (!cancelled) setMessages([]);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not load the chat workspace.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, refreshThreads, resourceId, threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, tools]);

  const startNew = useCallback(
    (nextAgentId: string = agentId) => {
      const nextThreadId = createOwnedThreadId(
        nextAgentId,
        resourceId,
      );
      router.push(buildChatHref(nextAgentId, nextThreadId));
    },
    [agentId, resourceId, router],
  );

  const openThread = (next: StudioThread) => {
    if (isStreaming) return;
    const nextAgentId = next.agentId || agentId;
    router.push(buildChatHref(nextAgentId, next.id));
  };

  const deleteThread = async (target: StudioThread) => {
    if (
      isStreaming ||
      !window.confirm(`Delete “${target.title}” and its messages?`)
    ) {
      return;
    }

    try {
      await removeThread(agentId, target.id, resourceId);
      if (target.id === threadId) {
        startNew(agentId);
      } else {
        await refreshThreads();
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not delete the thread.',
      );
    }
  };

  const upsertTool = (event: ToolEvent) => {
    setTools((current) => {
      const exists = current.some(
        (item) => item.toolCallId === event.toolCallId,
      );

      return exists
        ? current.map((item) =>
            item.toolCallId === event.toolCallId
              ? { ...item, ...event }
              : item,
          )
        : [...current, event];
    });
  };

  const consumeStream = async (
    stream: Awaited<ReturnType<typeof agent.stream>>,
    assistantId: string,
  ) => {
    let finished = false;
    // A run that suspends to request tool approval ends without a `finish`
    // chunk. Treat seeing a `tool-call-approval` chunk as a valid end state so
    // the assistant bubble isn't mislabelled "Generation ended before a final
    // response was produced." while the Approve/Decline buttons are shown.
    let awaitingApproval = false;
    const seen = new Set<string>();

    await stream.processDataStream({
      onChunk: (chunk) => {
        const payload = readChunkPayload(chunk);

        if (chunk.type === 'tool-call-approval') {
          awaitingApproval = true;
        }

        if (
          chunk.type === 'text-delta' &&
          typeof payload.text === 'string'
        ) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    content: message.content + payload.text,
                  }
                : message,
            ),
          );
        }

        if (
          [
            'tool-call',
            'tool-result',
            'tool-error',
            'tool-call-approval',
          ].includes(chunk.type)
        ) {
          const toolCallId = String(
            payload.toolCallId || crypto.randomUUID(),
          );
          seen.add(toolCallId);

          const status =
            chunk.type === 'tool-call-approval'
              ? 'approval'
              : chunk.type === 'tool-result'
                ? 'complete'
                : chunk.type === 'tool-error'
                  ? 'error'
                  : 'running';

          upsertTool({
            id: toolCallId,
            messageId: assistantId,
            toolCallId,
            toolName: String(payload.toolName || 'tool'),
            status,
            args: payload.args,
            result:
              payload.result ?? payload.output ?? payload.error,
            runId: chunk.runId,
          });
        }

        if (chunk.type === 'finish' || chunk.type === 'error') {
          finished = true;
        }

        if (chunk.type === 'error') {
          const detail =
            typeof payload.error === 'string'
              ? payload.error
              : 'The agent request failed.';

          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: detail, error: true }
                : message,
            ),
          );
        }
      },
    });

    if (!finished && !awaitingApproval) {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId && !message.content
            ? {
                ...message,
                error: true,
                content:
                  'Generation ended before a final response was produced.',
              }
            : message,
        ),
      );
    }

    void seen;
  };

  const sendMessage = async (raw: string) => {
    const prompt = raw.trim();

    if (
      !prompt ||
      isStreaming ||
      !threadOwned ||
      !modelReady
    ) {
      return;
    }

    const firstTurn = messages.length === 0;
    // Timestamp + id are intentionally captured at the user-action boundary
    // (this runs in the submit handler, not during render), so the
    // react-hooks/purity rule does not apply here.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    const assistantId = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        createdAt: now,
      },
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      },
    ]);
    setInput('');
    setError(undefined);
    setIsStreaming(true);

    try {
      const stream = await agent.stream(prompt, {
        memory: {
          thread: threadId,
          resource: resourceId,
        },
        requestContext: requestContext(),
      });

      await consumeStream(stream, assistantId);

      if (firstTurn) {
        const title =
          prompt.length > 52
            ? `${prompt.slice(0, 49).trim()}…`
            : prompt;

        try {
          await renameThread(
            agentId,
            threadId,
            resourceId,
            title,
          );
        } catch {
          // The stream remains successful even if title generation/update fails.
        }
      }

      await refreshThreads();
    } catch (reason) {
      const detail =
        reason instanceof Error
          ? reason.message
          : 'Unknown connection error';

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                error: true,
                content: `Could not complete request. ${detail}`,
              }
            : message,
        ),
      );
    } finally {
      setIsStreaming(false);
      textareaRef.current?.focus();
    }
  };

  const resolveApproval = async (
    event: ToolEvent,
    approved: boolean,
  ) => {
    if (!event.runId) return;

    upsertTool({
      ...event,
      status: approved ? 'running' : 'declined',
    });
    setIsStreaming(true);

    try {
      const { text, toolResult } = await resumeApprovalGenerate(
        agent,
        event.runId,
        event.toolCallId,
        approved,
        requestContext(),
      );

      upsertTool({
        ...event,
        status: approved ? 'complete' : 'declined',
        ...(toolResult
          ? { result: toolResult.result ?? toolResult.output }
          : {}),
      });

      setMessages((current) =>
        current.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                error: undefined,
                content: text || message.content,
              }
            : message,
        ),
      );
    } catch (reason) {
      const detail =
        reason instanceof Error
          ? reason.message
          : 'Could not resume the agent after approval.';
      setMessages((current) =>
        current.map((message) =>
          message.id === event.messageId
            ? { ...message, error: true, content: detail }
            : message,
        ),
      );
    } finally {
      setIsStreaming(false);
    }
  };

  const stop = async () => {
    await agent.abortThread({
      resourceId,
      threadId,
    });
    setIsStreaming(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const keyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  };

  if (!threadOwned) {
    return (
      <div className="studio-fatal">
        <BrandMark />
        <h1>Thread ownership mismatch</h1>
        <p>
          This thread does not belong to the selected agent and local
          resource.
        </p>
        <button
          className="studio-button studio-button-primary"
          type="button"
          onClick={() => startNew(MAIN_AGENT_ID)}
        >
          Start a safe conversation
        </button>
      </div>
    );
  }

  return (
    <div className="chat-studio-shell">
      <ResizableSidebar
        id="chat-thread-sidebar"
        className="chat-thread-rail"
        storageKey="chekku-chat-sidebar"
        label="Conversation sidebar"
      >
        {(collapsed, toggleCollapsed) => (
          <>
        <div className="studio-brand-row chat-brand-row">
          <button
            className="studio-brand chat-brand"
            type="button"
            onClick={() => router.push('/agents')}
            aria-label="Open agents"
            title={collapsed ? 'Open agents' : undefined}
          >
            <BrandMark />
            <span className="studio-sidebar-copy">
              <strong>Chekku</strong>
              <small>Agent Studio</small>
            </span>
          </button>
          <button
            className="studio-sidebar-collapse"
            type="button"
            onClick={toggleCollapsed}
            aria-controls="chat-thread-sidebar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand Conversation sidebar' : 'Collapse Conversation sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        <button
          className="studio-primary-action"
          type="button"
          onClick={() => startNew(agentId)}
          disabled={isStreaming}
          aria-label="New chat"
          title={collapsed ? 'New chat' : undefined}
        >
          <span>＋</span>
          <span className="studio-sidebar-copy">New chat</span>
        </button>

        <label className="studio-field chat-agent-select studio-sidebar-copy">
          <span>Active agent</span>
          <select
            value={agentId}
            disabled={isStreaming}
            onChange={(event) => startNew(event.target.value)}
          >
            {agents.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <label className="studio-search chat-search studio-sidebar-copy">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search threads"
          />
        </label>

        <div className="chat-thread-heading studio-sidebar-copy">
          <p className="studio-eyebrow">Recent threads</p>
          <span>{threads.length}</span>
        </div>

        <nav className="chat-thread-list studio-sidebar-copy" aria-label="Conversation history">
          {filteredThreads.map((thread) => (
            <div
              className={`chat-thread-row ${
                thread.id === threadId ? 'active' : ''
              }`}
              key={thread.id}
            >
              <button
                type="button"
                onClick={() => openThread(thread)}
                disabled={isStreaming}
              >
                <strong>{thread.title}</strong>
                <small>
                  {new Date(thread.updatedAt).toLocaleDateString()}
                </small>
              </button>
              <button
                className="chat-thread-delete"
                type="button"
                onClick={() => void deleteThread(thread)}
                aria-label={`Delete ${thread.title}`}
              >
                ×
              </button>
            </div>
          ))}

          {!loading && filteredThreads.length === 0 && (
            <p className="chat-no-threads">
              Threads appear here after their first message.
            </p>
          )}
        </nav>

          </>
        )}
      </ResizableSidebar>

      <main className="chat-workspace">
        <header className="chat-topbar">
          <div>
            <p className="studio-eyebrow">Agent workspace</p>
            <h1>{currentAgent?.name || agentId}</h1>
          </div>

          <div className="chat-topbar-actions">
            {agentId === QA_WEB_AGENT_ID && (
              <span className="chat-browser-badge">◎ Browser agent</span>
            )}
            <button
              className={`chat-access-switch ${
                accessMode === 'full' ? 'full' : ''
              }`}
              type="button"
              role="switch"
              aria-checked={accessMode === 'full'}
              onClick={() =>
                setAccessMode((current) =>
                  current === 'approval' ? 'full' : 'approval',
                )
              }
              disabled={isStreaming}
            >
              <span>
                <i />
              </span>
              {accessMode === 'full' ? 'Full access' : 'Ask first'}
            </button>
          </div>
        </header>

        <section
          className={`chat-conversation ${
            messages.length ? 'has-messages' : ''
          }`}
          aria-live="polite"
        >
          {loading ? (
            <div className="chat-loading">
              <BrandMark />
              <p>Loading thread from Mastra Memory…</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="chat-welcome">
              <h2>
                What should we <em>do?</em>
              </h2>
            </div>
          ) : (
            <div className="chat-message-list">
              {messages.map((message) => {
                const relatedTools = tools.filter(
                  (tool) => tool.messageId === message.id,
                );

                return (
                  <article
                    className={`chat-message ${message.role} ${
                      message.error ? 'error' : ''
                    }`}
                    key={message.id}
                  >
                    <div className="chat-message-label">
                      {message.role === 'assistant' ? (
                        <BrandMark />
                      ) : (
                        <span className="chat-user-avatar">You</span>
                      )}
                      <strong>
                        {message.role === 'assistant'
                          ? currentAgent?.name || 'Chekku'
                          : 'You'}
                      </strong>
                      <time>
                        {new Date(
                          message.createdAt,
                        ).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>

                    {relatedTools.length > 0 && (
                      <div className="chat-tool-timeline">
                        {relatedTools.map((tool) => (
                          <details
                            className={`chat-tool-card ${tool.status}`}
                            key={tool.id}
                          >
                            <summary>
                              <span />
                              <strong>
                                {tool.toolName.replaceAll('_', ' ')}
                              </strong>
                              <small>{tool.status}</small>
                              <i>⌄</i>
                            </summary>

                            {tool.args !== undefined && (
                              <pre>{safeDisplay(tool.args)}</pre>
                            )}
                            {tool.result !== undefined && (
                              <pre>{safeDisplay(tool.result)}</pre>
                            )}

                            {tool.status === 'approval' && (
                              <div className="chat-approval-actions">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void resolveApproval(tool, false)
                                  }
                                >
                                  Decline
                                </button>
                                <button
                                  className="studio-button-primary"
                                  type="button"
                                  onClick={() =>
                                    void resolveApproval(tool, true)
                                  }
                                >
                                  Approve action
                                </button>
                              </div>
                            )}
                          </details>
                        ))}
                      </div>
                    )}

                    <div className="chat-message-content markdown">
                      {message.content ? (
                        <MarkdownMessage content={message.content} />
                      ) : (
                        <span className="chat-typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </div>

                    {message.role === 'assistant' && message.content && (
                      <div className="chat-message-actions">
                        <button
                          type="button"
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              message.content,
                            )
                          }
                        >
                          Copy
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </section>

        <div className="chat-composer-wrap">
          {error && (
            <div className="studio-alert studio-alert-error">
              {error}
            </div>
          )}
          {!modelReady && !loading && (
            <div className="studio-alert studio-alert-error">
              No model was returned by the server’s <code>/models</code>{' '}
              endpoint.
            </div>
          )}

          <form className="chat-composer" onSubmit={submit}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={keyDown}
              placeholder={
                modelReady
                  ? `Message ${currentAgent?.name || agentId}…`
                  : 'Configure the server model first…'
              }
              disabled={!modelReady || isStreaming}
              rows={1}
            />

            <footer>
              <div>
                <span className="chat-memory-chip">◇ Memory</span>
                {agentId === QA_WEB_AGENT_ID && (
                  <span className="chat-memory-chip">◎ Browser</span>
                )}
              </div>

              <div>
                <small>Shift + Enter for new line</small>
                {isStreaming ? (
                  <button
                    className="chat-stop-button"
                    type="button"
                    onClick={() => void stop()}
                    aria-label="Stop generation"
                  >
                    ■
                  </button>
                ) : (
                  <button
                    className="chat-send-button"
                    type="submit"
                    disabled={!input.trim() || !modelReady}
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                )}
              </div>
            </footer>
          </form>

          <p className={accessMode === 'full' ? 'warning' : ''}>
            {accessMode === 'full'
              ? 'Full access is active. Browser actions run without approval.'
              : 'Ask first is active. Consequential browser actions require approval.'}
          </p>
        </div>
      </main>
    </div>
  );
}
