'use client';

import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { CommandMenu } from '@/components/chat/command-menu';
import {
  commandFilterText,
  isCommandInput,
  resolveCommandKey,
  selectSkillByIndex,
} from '@/components/chat/command-picker';
import { MarkdownMessage } from '@/components/markdown-message';
import { ResizableSidebar } from '@/components/studio/resizable-sidebar';
import { BrandMark } from '@/components/ui/brand-mark';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { AgentIcon } from '@/components/agents/agent-icon';
import { defaultAgentIcon } from '@/lib/agent-icons';
import {
  listAgentSkills,
  type AgentSkillSummary,
} from '@/lib/agent-skills';
import {
  ATTACHMENT_ACCEPT_ATTR,
  MAX_ATTACHMENTS_PER_MESSAGE,
  buildUserMessageContent,
  classifyAttachment,
  exceedsTotalBase64Limit,
  prepareImageAttachment,
  preparePdfAttachment,
  prepareTextAttachment,
  toAttachmentView,
  type PreparedAttachment,
} from '@/lib/chat-attachments';
import { browserImageDeps, browserPdfDeps } from '@/lib/chat-attachments-browser';
import { buildChatHref } from '@/lib/chat-route';
import {
  listAgentThreads,
  listThreadMessages,
  removeThread,
  renameThread,
  type StudioMemoryMessage,
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
  QA_ANDROID_AGENT_ID,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolEvent,
} from '@/lib/types';

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

function messageFromMemory(value: StudioMemoryMessage): ChatMessage {
  const { attachments: restored, ...base } = value;
  const attachments = restored?.map((attachment, index) => ({
    id: `${value.id}-att-${index}`,
    kind: 'image' as const,
    filename: attachment.filename ?? `attachment-${index + 1}`,
    mimeType: attachment.mimeType,
    dataUrl: attachment.dataUrl,
  }));
  return {
    ...base,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

type PendingUpload = {
  id: string;
  filename: string;
  kind: 'text' | 'image' | 'pdf';
  status: 'preparing' | 'ready' | 'error';
  error?: string;
  prepared?: PreparedAttachment;
};

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
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The dialog's confirm button only disables on the next render, so a fast
  // double-click can fire onConfirm twice. A ref closes that window
  // synchronously; `deletingThreadId` below is for rendering only.
  const deleteInFlightRef = useRef(false);

  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [threads, setThreads] = useState<StudioThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const [modelReady, setModelReady] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StudioThread>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();

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

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await listAgentThreads(resourceId, agentId));
    } catch {
      setThreads([]);
    }
  }, [agentId, resourceId]);

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

  useEffect(() => {
    let cancelled = false;
    listAgentSkills(agentId).then((result) => {
      if (!cancelled) setSkills(result);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const filteredSkills = useMemo(() => {
    const filterText = commandFilterText(input);
    if (filterText === '' || filterText === 'skills') return skills;
    const needle = filterText.toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(needle));
  }, [input, skills]);

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

  const replaceWithNew = useCallback(
    (nextAgentId: string = agentId) => {
      const nextThreadId = createOwnedThreadId(
        nextAgentId,
        resourceId,
      );
      router.replace(buildChatHref(nextAgentId, nextThreadId));
    },
    [agentId, resourceId, router],
  );

  const openThread = (next: StudioThread) => {
    if (isStreaming) return;
    const nextAgentId = next.agentId || agentId;
    router.push(buildChatHref(nextAgentId, next.id));
  };

  const deleteThread = async () => {
    const target = pendingDelete;
    if (isStreaming || !target || deleteInFlightRef.current) return;

    deleteInFlightRef.current = true;
    setDeletingThreadId(target.id);
    try {
      await removeThread(agentId, target.id, resourceId);
      setThreads((current) =>
        current.filter((thread) => thread.id !== target.id),
      );
      setError(undefined);
      if (target.id === threadId) {
        setMessages([]);
        setTools([]);
        setInput('');
        setUploads([]);
        setCommandOpen(false);
        replaceWithNew(agentId);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not delete the thread.',
      );
    } finally {
      deleteInFlightRef.current = false;
      setDeletingThreadId(undefined);
      setPendingDelete(undefined);
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
    const seen = new Set<string>();

    await stream.processDataStream({
      onChunk: (chunk) => {
        const payload = readChunkPayload(chunk);

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
          ['tool-call', 'tool-result', 'tool-error'].includes(chunk.type)
        ) {
          const toolCallId = String(
            payload.toolCallId || crypto.randomUUID(),
          );
          seen.add(toolCallId);

          const status =
            chunk.type === 'tool-result'
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

        if (
          chunk.type === 'finish' ||
          chunk.type === 'error' ||
          chunk.type === 'tripwire'
        ) {
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

        if (chunk.type === 'tripwire') {
          const reason =
            typeof payload.reason === 'string' && payload.reason.trim()
              ? payload.reason
              : 'The request exceeded a processing limit.';

          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    content: `Request stopped by a safety limit. ${reason}`,
                    error: true,
                  }
                : message,
            ),
          );
        }
      },
    });

    if (!finished) {
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

  const readyUploads = useMemo(
    () =>
      uploads.flatMap((upload) =>
        upload.status === 'ready' && upload.prepared
          ? [upload.prepared]
          : [],
      ),
    [uploads],
  );
  const preparingUploads = uploads.some(
    (upload) => upload.status === 'preparing',
  );

  const prepareUpload = async (file: File) => {
    const id = crypto.randomUUID();
    const kind = classifyAttachment(file);

    if (kind === 'unsupported') {
      setUploads((current) => [
        ...current,
        {
          id,
          filename: file.name,
          kind: 'text',
          status: 'error',
          error: 'This file type is not supported.',
        },
      ]);
      return;
    }

    setUploads((current) => [
      ...current,
      { id, filename: file.name, kind, status: 'preparing' },
    ]);

    try {
      const prepared =
        kind === 'text'
          ? await prepareTextAttachment(file)
          : kind === 'image'
            ? await prepareImageAttachment(file, browserImageDeps)
            : await preparePdfAttachment(
                file,
                browserImageDeps,
                await browserPdfDeps(),
              );
      setUploads((current) =>
        current.map((upload) =>
          upload.id === id
            ? { ...upload, status: 'ready', prepared }
            : upload,
        ),
      );
    } catch (reason) {
      setUploads((current) =>
        current.map((upload) =>
          upload.id === id
            ? {
                ...upload,
                status: 'error',
                error:
                  reason instanceof Error && reason.message
                    ? reason.message
                    : 'This file could not be processed.',
              }
            : upload,
        ),
      );
    }
  };

  const addFiles = (files: File[]) => {
    if (isStreaming || !modelReady) return;

    const room = MAX_ATTACHMENTS_PER_MESSAGE - uploads.length;
    if (room <= 0) {
      setError(
        `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.`,
      );
      return;
    }

    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      setError(
        `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.`,
      );
    }
    for (const file of accepted) void prepareUpload(file);
  };

  const removeUpload = (id: string) => {
    setUploads((current) => current.filter((upload) => upload.id !== id));
  };

  const sendMessage = async (raw: string) => {
    const prompt = raw.trim();

    if (
      (!prompt && readyUploads.length === 0) ||
      preparingUploads ||
      isStreaming ||
      !threadOwned ||
      !modelReady
    ) {
      return;
    }

    if (exceedsTotalBase64Limit(readyUploads)) {
      setError(
        'These attachments exceed the 8 MB total limit for one message. Remove some files and try again.',
      );
      return;
    }

    const attachmentViews = readyUploads.map(toAttachmentView);
    const firstTurn = messages.length === 0;
    const now = Date.now();
    const assistantId = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        createdAt: now,
        ...(attachmentViews.length > 0 ? { attachments: attachmentViews } : {}),
      },
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      },
    ]);
    setInput('');
    setUploads([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setError(undefined);
    setIsStreaming(true);

    try {
      const stream = await agent.stream(
        [
          {
            role: 'user',
            content: buildUserMessageContent(prompt, readyUploads),
          },
        ],
        {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
        },
      );

      await consumeStream(stream, assistantId);

      if (firstTurn) {
        const titleSource =
          prompt ||
          (attachmentViews[0]?.filename
            ? `${attachmentViews[0].filename}`
            : 'Attachment');
        const title =
          titleSource.length > 52
            ? `${titleSource.slice(0, 49).trim()}…`
            : titleSource;

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

  const applySelection = (name: string) => {
    setInput(`/${name} `);
    setCommandOpen(false);
    setCommandIndex(0);
  };

  const selectCommand = () => {
    const name = selectSkillByIndex(
      commandIndex,
      filteredSkills.map((s) => s.name),
    );
    if (name) applySelection(name);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = resolveCommandKey(
      event.key,
      commandOpen,
      filteredSkills.length > 0,
    );
    if (action !== 'default') event.preventDefault();
    if (action === 'next') {
      setCommandIndex((i) => i + 1);
      return;
    }
    if (action === 'prev') {
      setCommandIndex((i) => i - 1);
      return;
    }
    if (action === 'select') {
      selectCommand();
      return;
    }
    if (action === 'close') {
      setCommandOpen(false);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(
      (file) => classifyAttachment(file) !== 'unsupported',
    );
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  const dragOverForm = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragOver(true);
  };

  const dropForm = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragOver(false);
    addFiles(Array.from(event.dataTransfer?.files ?? []));
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
                disabled={isStreaming || Boolean(deletingThreadId)}
                onClick={() => setPendingDelete(thread)}
                aria-label={`Delete ${thread.title}`}
                aria-haspopup="dialog"
              >
                {deletingThreadId === thread.id ? '…' : '×'}
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
            <h1 ref={workspaceHeadingRef} tabIndex={-1}>
              {currentAgent?.name || agentId}
            </h1>
          </div>

          <div className="chat-topbar-actions">
            {agentId === QA_WEB_AGENT_ID && (
              <span className="chat-browser-badge">◎ Browser agent</span>
            )}
            {agentId === QA_ANDROID_AGENT_ID && (
              <span className="chat-browser-badge">▷ Android Agent</span>
            )}
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
                        <AgentIcon icon={currentAgent?.iconKey ?? defaultAgentIcon(agentId)} />
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
                          </details>
                        ))}
                      </div>
                    )}

                    <div className="chat-message-content markdown">
                      {message.content ? (
                        <MarkdownMessage content={message.content} />
                      ) : message.role === 'assistant' ? (
                        <span className="chat-typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : null}
                    </div>

                    {message.role === 'user' &&
                      message.attachments &&
                      message.attachments.length > 0 && (
                        <div
                          className="chat-message-attachments"
                          role="list"
                          aria-label="Attached files"
                        >
                          {message.attachments.map((attachment, index) =>
                            attachment.dataUrl ? (
                              // Data-URL thumbnails cannot use next/image without
                              // per-origin configuration; a plain img is correct here.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={attachment.id || `${message.id}-att-${index}`}
                                className="chat-attachment-thumb"
                                src={attachment.dataUrl}
                                alt={
                                  attachment.filename ||
                                  `Attached image ${index + 1}`
                                }
                                loading="lazy"
                              />
                            ) : (
                              <span
                                className="chat-attachment-file"
                                key={attachment.id || `${message.id}-att-${index}`}
                                role="listitem"
                              >
                                ≡ {attachment.filename}
                                {attachment.pageCount
                                  ? ` (${attachment.pageCount} pages)`
                                  : ''}
                              </span>
                            ),
                          )}
                        </div>
                      )}

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

          <form
            className={`chat-composer${dragOver ? ' drag-over' : ''}`}
            onSubmit={submit}
            onDragOver={dragOverForm}
            onDragLeave={() => setDragOver(false)}
            onDrop={dropForm}
          >
            <div className="chat-composer__input">
              {uploads.length > 0 && (
                <div
                  className="chat-upload-row"
                  role="list"
                  aria-label="Pending attachments"
                >
                  {uploads.map((upload) => (
                    <span
                      className={`chat-upload-chip ${upload.status}`}
                      key={upload.id}
                      role="listitem"
                    >
                      <span aria-hidden="true">
                        {upload.kind === 'image'
                          ? '▣'
                          : upload.kind === 'pdf'
                            ? '⎘'
                            : '≡'}
                      </span>
                      <span className="chat-upload-name">
                        {upload.filename}
                        {upload.prepared?.kind === 'pdf'
                          ? ` (${upload.prepared.pages.length} pages)`
                          : ''}
                      </span>
                      {upload.status === 'preparing' && (
                        <small>processing…</small>
                      )}
                      {upload.status === 'error' && upload.error && (
                        <small>{upload.error}</small>
                      )}
                      <button
                        type="button"
                        onClick={() => removeUpload(upload.id)}
                        aria-label={`Remove ${upload.filename}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {commandOpen && filteredSkills.length > 0 ? (
                <CommandMenu
                  commands={filteredSkills}
                  activeIndex={commandIndex}
                  onSelect={applySelection}
                />
              ) : null}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  const value = event.target.value;
                  setInput(value);
                  const isCommand = isCommandInput(value);
                  setCommandOpen(isCommand);
                  if (isCommand) setCommandIndex(0);
                }}
                onKeyDown={keyDown}
                onPaste={paste}
                placeholder={
                  modelReady
                    ? `Message ${currentAgent?.name || agentId}…`
                    : 'Configure the server model first…'
                }
                disabled={!modelReady || isStreaming}
                rows={1}
              />
            </div>

            <footer>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  accept={ATTACHMENT_ACCEPT_ATTR}
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                />
                <button
                  className="chat-attach-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!modelReady || isStreaming}
                  aria-label="Attach files"
                  title="Attach files"
                >
                  ＋ Attach
                </button>
                <span className="chat-memory-chip">◇ Memory</span>
                {agentId === QA_WEB_AGENT_ID && (
                  <span className="chat-memory-chip">◎ Browser</span>
                )}
                {agentId === QA_ANDROID_AGENT_ID && (
                  <span className="chat-memory-chip">▷ Maestro</span>
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
                    disabled={
                      (!input.trim() && readyUploads.length === 0) ||
                      preparingUploads ||
                      !modelReady
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                )}
              </div>
            </footer>
          </form>
        </div>
      </main>
      <ConfirmationDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? `Delete ${pendingDelete.title}?` : 'Delete thread?'}
        description="This permanently removes the conversation and all of its messages."
        pending={Boolean(deletingThreadId)}
        fallbackFocusRef={workspaceHeadingRef}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => void deleteThread()}
      />
    </div>
  );
}
