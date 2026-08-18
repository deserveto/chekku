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
import { buildChatHref } from '@/lib/chat-route';
import {
  listAgentThreads,
  listThreadMessages,
  removeThread,
  type StudioThread,
} from '@/lib/memory-threads';
import {
  RunConflictError,
  cancelRun,
  getActiveRun,
  isTerminalRunEvent,
  listActiveRuns,
  observeRunEvents,
  startRun,
  type AgentRunEvent,
  type AgentRunSummary,
} from '@/lib/agent-runs';
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
  appendTextDelta,
  groupAssistantParts,
  upsertToolPart,
} from '@/lib/assistant-parts';
import {
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  QA_ANDROID_AGENT_ID,
  type AssistantPart,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolAssistantPart,
  type ToolEventStatus,
} from '@/lib/types';

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
    parts?: AssistantPart[];
    createdAt: number;
  },
): ChatMessage {
  return { ...value };
}

function TypingIndicator() {
  return (
    <div className="chat-message-content markdown">
      <span className="chat-typing">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function ToolCallCard({ tool }: { tool: ToolAssistantPart }) {
  return (
    <details className={`chat-tool-card ${tool.status}`}>
      <summary>
        <span />
        <strong>{tool.toolName.replaceAll('_', ' ')}</strong>
        <small>{tool.status}</small>
        <i>⌄</i>
      </summary>

      {tool.args !== undefined && <pre>{safeDisplay(tool.args)}</pre>}
      {tool.result !== undefined && <pre>{safeDisplay(tool.result)}</pre>}
    </details>
  );
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
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The dialog's confirm button only disables on the next render, so a fast
  // double-click can fire onConfirm twice. A ref closes that window
  // synchronously; `deletingThreadId` below is for rendering only.
  const deleteInFlightRef = useRef(false);
  // Authoritative execution state lives on the server (`activeRun`); the
  // subscription controller only tracks this component's observation of it.
  const subscriptionRef = useRef<AbortController | null>(null);
  const lastTerminalRef = useRef<string | null>(null);
  const sidebarRunsRef = useRef<Record<string, boolean>>({});

  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [threads, setThreads] = useState<StudioThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeRun, setActiveRun] = useState<AgentRunSummary | null>(null);
  const [subscriptionState, setSubscriptionState] = useState<
    'idle' | 'connecting' | 'connected'
  >('idle');
  const [sidebarRuns, setSidebarRuns] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  const [modelReady, setModelReady] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StudioThread>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();

  const agentId = initialAgentId;
  const threadId = initialThreadId;

  const currentAgent = agents.find((entry) => entry.id === agentId);
  const threadOwned = isOwnedThreadId(threadId, agentId, resourceId);
  const runActive = activeRun?.status === 'running';
  const threadHasActiveRun = (id: string) =>
    Boolean(sidebarRuns[id]) || (id === threadId && runActive);

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

  const applyRunEvent = useCallback((event: AgentRunEvent, assistantId: string) => {
    setSubscriptionState('connected');

    if (
      event.type === 'text-delta' &&
      typeof event.payload.text === 'string'
    ) {
      const text = event.payload.text;
      setMessages((current) => {
        const exists = current.some((message) => message.id === assistantId);
        const base = exists
          ? current
          : [
              ...current,
              {
                id: assistantId,
                role: 'assistant' as const,
                content: '',
                createdAt: Date.now(),
              },
            ];
        return base.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: message.content + text,
                parts: appendTextDelta(message.parts ?? [], text),
              }
            : message,
        );
      });
      return;
    }

    if (
      event.type === 'tool-call' ||
      event.type === 'tool-result' ||
      event.type === 'tool-error'
    ) {
      const toolCallId = String(
        event.payload.toolCallId || crypto.randomUUID(),
      );
      const status: ToolEventStatus =
        event.type === 'tool-result'
          ? 'complete'
          : event.type === 'tool-error'
            ? 'error'
            : 'running';
      const toolName =
        event.payload.toolName !== undefined
          ? String(event.payload.toolName)
          : undefined;
      const args = event.payload.args;
      const result = event.payload.result ?? event.payload.error;
      const runId =
        event.payload.runId !== undefined
          ? String(event.payload.runId)
          : undefined;

      setMessages((current) => {
        const exists = current.some((message) => message.id === assistantId);
        const base = exists
          ? current
          : [
              ...current,
              {
                id: assistantId,
                role: 'assistant' as const,
                content: '',
                createdAt: Date.now(),
              },
            ];
        return base.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                parts: upsertToolPart(message.parts ?? [], {
                  toolCallId,
                  status,
                  toolName,
                  args,
                  result,
                  runId,
                }),
              }
            : message,
        );
      });
      return;
    }

    if (event.type === 'error') {
      const detail =
        typeof event.payload.error === 'string' && event.payload.error
          ? event.payload.error
          : 'The agent request failed.';

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: message.content ? `${message.content}\n\n${detail}` : detail,
                parts: appendTextDelta(
                  message.parts ?? [],
                  message.content ? `\n\n${detail}` : detail,
                ),
                error: true,
              }
            : message,
        ),
      );
      return;
    }

    if (isTerminalRunEvent(event)) {
      lastTerminalRef.current = event.type;
    }
  }, []);

  const finalizeTerminalMessage = useCallback((assistantId: string) => {
    const terminal = lastTerminalRef.current;
    if (terminal !== 'cancelled' && terminal !== 'error') return;

    const fallback =
      terminal === 'cancelled'
        ? 'Generation was stopped.'
        : 'The agent run failed.';

    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId && !message.content
          ? {
              ...message,
              error: terminal === 'error',
              content: fallback,
              parts: appendTextDelta(message.parts ?? [], fallback),
            }
          : message,
      ),
    );
  }, []);

  const beginSubscription = useCallback(
    (runId: string, assistantId: string) => {
      // Supersede any previous observation; this never cancels the run.
      subscriptionRef.current?.abort();
      const controller = new AbortController();
      subscriptionRef.current = controller;
      lastTerminalRef.current = null;
      setSubscriptionState('connecting');

      void observeRunEvents(runId, {
        signal: controller.signal,
        offset: 0,
        onEvent: (event) => applyRunEvent(event, assistantId),
      }).then(() => {
        if (subscriptionRef.current !== controller) return;
        subscriptionRef.current = null;
        setSubscriptionState('idle');
        setActiveRun(null);
        finalizeTerminalMessage(assistantId);
        void refreshThreads();
        textareaRef.current?.focus();
      });
    },
    [applyRunEvent, finalizeTerminalMessage, refreshThreads],
  );

  /**
   * Attaches this view to an in-flight run it did not start (mount
   * discovery or a 409 duplicate). Mastra persists the user message only
   * at turn end, so the run's prompt is synthesized locally and an empty
   * assistant placeholder is added — replayed tool events then have a
   * message to render under even before the first text delta arrives.
   */
  const attachToRun = useCallback(
    (run: AgentRunSummary) => {
      const assistantId = crypto.randomUUID();
      const startedAt = Date.parse(run.startedAt) || Date.now();

      setMessages((current) => {
        // Memory may already contain the persisted turn (completed between
        // loading messages and discovering the run) — then nothing to add.
        if (
          current.some(
            (message) =>
              message.role === 'user' && message.content === run.prompt,
          )
        ) {
          return current;
        }
        return [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'user' as const,
            content: run.prompt,
            createdAt: startedAt,
          },
          {
            id: assistantId,
            role: 'assistant' as const,
            content: '',
            createdAt: startedAt + 1,
          },
        ];
      });

      setActiveRun(run);
      beginSubscription(run.id, assistantId);
    },
    [beginSubscription],
  );

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

        // Reconnect to a run that is still executing for this thread
        // (started before a navigation or page reload). Subscribing replays
        // buffered events, so the in-flight output and tool progress are
        // reconstructed without starting a duplicate run.
        try {
          const run = await getActiveRun(agentId, threadId);
          if (!cancelled && run && run.status === 'running') {
            attachToRun(run);
          }
        } catch {
          // Run discovery is best-effort; the thread still renders from Memory.
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
      // Dropping the observation never cancels the server-owned run.
      subscriptionRef.current?.abort();
      subscriptionRef.current = null;
      // The component instance survives thread switches (no remount key),
      // so the previous thread's run state must not leak into the next
      // thread: a stale activeRun would keep the composer disabled and
      // point thread B's Stop button at thread A's run.
      setActiveRun(null);
      setSubscriptionState('idle');
      lastTerminalRef.current = null;
    };
  }, [agentId, attachToRun, refreshThreads, resourceId, threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    listAgentSkills(agentId).then((result) => {
      if (!cancelled) setSkills(result);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Sidebar run indicators: poll the server's active runs for this agent
  // so threads keep showing live status while the user views another
  // thread. When a thread leaves the active set, its run finished and the
  // thread list needs a refresh (new message / server-side title).
  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      try {
        const runs = await listActiveRuns(agentId);
        if (stopped) return;
        const next: Record<string, boolean> = {};
        for (const run of runs) next[run.threadId] = true;
        const previous = sidebarRunsRef.current;
        const completedElsewhere = Object.keys(previous).some(
          (id) => next[id] !== true,
        );
        sidebarRunsRef.current = next;
        setSidebarRuns(next);
        if (completedElsewhere) void refreshThreads();
      } catch {
        // Transient polling failures leave the last known status in place.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [agentId, refreshThreads]);

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
    // Navigation is always allowed: a running execution is server-owned
    // and survives leaving (and returning to) the thread.
    const nextAgentId = next.agentId || agentId;
    router.push(buildChatHref(nextAgentId, next.id));
  };

  const deleteThread = async () => {
    const target = pendingDelete;
    if (!target || deleteInFlightRef.current) return;
    if (threadHasActiveRun(target.id)) {
      setError(
        'This thread has a running conversation. Stop it before deleting.',
      );
      setPendingDelete(undefined);
      return;
    }

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
        setInput('');
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

  const sendMessage = async (raw: string) => {
    const prompt = raw.trim();

    if (
      !prompt ||
      runActive ||
      !threadOwned ||
      !modelReady
    ) {
      return;
    }

    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      {
        id: userMessageId,
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
    setSubscriptionState('connecting');

    try {
      const run = await startRun({
        agentId,
        threadId,
        prompt,
      });

      setActiveRun(run);
      beginSubscription(run.id, assistantId);
      // The server creates the Memory thread (titled from the prompt)
      // before the start response, so one refresh surfaces the new thread
      // in the sidebar immediately instead of after the run completes.
      void refreshThreads();
    } catch (reason) {
      if (reason instanceof RunConflictError && reason.run) {
        // Another client already started this thread's run (e.g. a second
        // tab). Drop the optimistic duplicate prompt and attach to the
        // existing run instead of starting a second execution; the existing
        // run's prompt is re-synthesized from the run record.
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== userMessageId && message.id !== assistantId,
          ),
        );
        attachToRun(reason.run);
        return;
      }

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
                parts: appendTextDelta(
                  message.parts ?? [],
                  `Could not complete request. ${detail}`,
                ),
              }
            : message,
        ),
      );
      setSubscriptionState('idle');
    }
  };

  const stop = async () => {
    const run = activeRun;
    if (!run) return;
    try {
      await cancelRun(run.id);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not stop the running conversation.',
      );
    }
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
              >
                <strong>{thread.title}</strong>
                {sidebarRuns[thread.id] ? (
                  <small className="chat-thread-status">
                    <span
                      className="chat-thread-running"
                      aria-label="Agent run in progress"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                    Running
                  </small>
                ) : (
                  <small>
                    {new Date(thread.updatedAt).toLocaleDateString()}
                  </small>
                )}
              </button>
              <button
                className="chat-thread-delete"
                type="button"
                disabled={
                  threadHasActiveRun(thread.id) || Boolean(deletingThreadId)
                }
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
                const partGroups =
                  message.role === 'assistant' && message.parts?.length
                    ? groupAssistantParts(message.parts)
                    : null;

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

                    {partGroups ? (
                      partGroups.map((group) =>
                        group.kind === 'tools' ? (
                          <div
                            className="chat-tool-timeline"
                            key={`tools-${group.parts[0]?.id}`}
                          >
                            {group.parts.map((tool) => (
                              <ToolCallCard key={tool.id} tool={tool} />
                            ))}
                          </div>
                        ) : (
                          <div
                            className="chat-message-content markdown"
                            key={group.part.id}
                          >
                            <MarkdownMessage content={group.part.content} />
                          </div>
                        ),
                      )
                    ) : message.content ? (
                      <div className="chat-message-content markdown">
                        <MarkdownMessage content={message.content} />
                      </div>
                    ) : (
                      <TypingIndicator />
                    )}

                    {partGroups && !message.content && runActive && (
                      <TypingIndicator />
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

          <form className="chat-composer" onSubmit={submit}>
            <div className="chat-composer__input">
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
                placeholder={
                  modelReady
                    ? `Message ${currentAgent?.name || agentId}…`
                    : 'Configure the server model first…'
                }
                disabled={!modelReady || runActive}
                rows={1}
              />
            </div>

            <footer>
              <div>
                <span className="chat-memory-chip">◇ Memory</span>
                {agentId === QA_WEB_AGENT_ID && (
                  <span className="chat-memory-chip">◎ Browser</span>
                )}
                {agentId === QA_ANDROID_AGENT_ID && (
                  <span className="chat-memory-chip">▷ Maestro</span>
                )}
              </div>

              <div>
                {runActive && subscriptionState !== 'connected' ? (
                  <small>Connecting to the running conversation…</small>
                ) : (
                  <small>Shift + Enter for new line</small>
                )}
                {runActive ? (
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
