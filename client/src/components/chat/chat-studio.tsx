'use client';

import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type StudioMemoryMessage,
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
import { isSafeImageSrc } from '@/lib/safe-image-src';
import {
  applyTaskSnapshot,
  isTaskToolName,
  parseTaskListPayload,
  tasksFromRestoredParts,
  withoutTaskToolParts,
  type ThreadTaskState,
} from '@/lib/task-list';
import { TaskDock } from '@/components/chat/task-dock';
import {
  ensureStoredAgentUsesServerGateway,
  listAllAgents,
} from '@/lib/stored-agents';
import { extractImageUrl } from '@/lib/tool-result';
import {
  createOwnedThreadId,
  isOwnedThreadId,
} from '@/lib/thread-id';
import {
  appendTextDelta,
  groupAssistantParts,
  interruptRunningToolParts,
  textFromAssistantParts,
  upsertToolPart,
} from '@/lib/assistant-parts';
import {
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  QA_ANDROID_AGENT_ID,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolAssistantPart,
  type ToolEventStatus,
} from '@/lib/types';

const TOOL_DISPLAY_LIMIT = 8_192;

/**
 * Distance (px) from the conversation's bottom within which auto-follow
 * stays attached while the agent streams.
 */
const CHAT_PIN_THRESHOLD_PX = 120;

/** localStorage key for the collapsed-dock UI preference (never task data). */
const TASK_DOCK_COLLAPSED_KEY = 'chekku-task-dock-collapsed';

function readTaskDockCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(TASK_DOCK_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Message timestamps: time only for today; otherwise a short date anchor so
 * multi-day threads keep temporal context.
 */
function formatMessageTime(value: string | number | Date): string {
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString([], {
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `${day} · ${time}`;
}

function safeDisplay(value: unknown): string {
  let text: string;
  if (value === undefined) return '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  if (text.length > TOOL_DISPLAY_LIMIT) {
    return `${text.slice(0, TOOL_DISPLAY_LIMIT)}\n… output truncated`;
  }
  return text;
}

function appendErrorDetail(message: ChatMessage, detail: string): ChatMessage {
  return {
    ...message,
    content: message.content ? `${message.content}\n\n${detail}` : detail,
    parts: appendTextDelta(
      message.parts ?? [],
      message.content ? `\n\n${detail}` : detail,
    ),
    error: true,
  };
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

function ToolCallCard({
  tool,
  collapseByDefault = false,
}: {
  tool: ToolAssistantPart;
  collapseByDefault?: boolean;
}) {
  const extracted =
    tool.result !== undefined ? extractImageUrl(tool.result) : null;
  // Same scheme allowlist as the markdown renderer — tool results are
  // model-influenced, so a non-http(s)/same-origin/data URL is dropped.
  const imageUrl =
    extracted && isSafeImageSrc(extracted) ? extracted : null;

  return (
    <details
      className={`chat-tool-card ${tool.status}`}
      open={collapseByDefault ? undefined : Boolean(imageUrl) || undefined}
    >
      <summary className="chat-tool-summary-v1">
        <span className="chat-tool-summary-marker" />
        <strong>{tool.toolName.replaceAll('_', ' ')}</strong>
        <i aria-hidden="true" />
      </summary>

      {imageUrl && (
        <div className="chat-tool-image-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`${tool.toolName} result`}
            className="chat-tool-image"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={imageUrl}
          />
        </div>
      )}

      {tool.args !== undefined && (
        <div className="chat-tool-section">
          <span className="chat-tool-label">input</span>
          <pre>{safeDisplay(tool.args)}</pre>
        </div>
      )}
      {tool.result !== undefined && (
        <div className="chat-tool-section">
          <span className="chat-tool-label">
            {tool.status === 'error' ? 'error' : 'result'}
          </span>
          <pre>{safeDisplay(tool.result)}</pre>
        </div>
      )}
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
  const conversationRef = useRef<HTMLElement>(null);
  // The dialog's confirm button only disables on the next render, so a fast
  // double-click can fire onConfirm twice. A ref closes that window
  // synchronously; `deletingThreadId` below is for rendering only.
  const deleteInFlightRef = useRef(false);
  // Authoritative execution state lives on the server (`activeRun`); the
  // subscription controller only tracks this component's observation of it.
  const subscriptionRef = useRef<AbortController | null>(null);
  const lastTerminalRef = useRef<string | null>(null);
  const sidebarRunsRef = useRef<Record<string, AgentRunSummary | null>>({});
  const dragDepthRef = useRef(0);
  // Whether any task snapshot was seen for the viewed thread; gates the
  // dock's auto-open so only the FIRST snapshot expands it.
  const hasTaskSnapshotRef = useRef(false);
  // The thread this instance currently renders. The component survives
  // thread switches (no remount key), so async callbacks started for one
  // thread (the startRun round-trip) compare against this ref to avoid
  // installing a stale thread's run into the newly viewed thread.
  const threadRef = useRef(initialThreadId);
  // ChatGPT-style pinned-to-bottom scrolling: streamed content only scrolls
  // the conversation while the user is already near its bottom. Any upward
  // scroll detaches the follow (freely reading history is never interrupted,
  // even inside the re-attach band) and returning near the bottom re-attaches
  // it. The ref is authoritative for effects; the state only drives the
  // jump-to-latest button. previousScrollTopRef gives the scroll handler a
  // direction signal: programmatic jumps only ever move down, so upward
  // movement is always user intent.
  const isPinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const previousScrollTopRef = useRef(0);

  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [threads, setThreads] = useState<StudioThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeRun, setActiveRun] = useState<AgentRunSummary | null>(null);
  // id of the assistant placeholder the active subscription streams into;
  // gates per-message UI (typing indicator) to the streaming turn only.
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(
    null,
  );
  const [subscriptionState, setSubscriptionState] = useState<
    'idle' | 'connecting' | 'connected'
  >('idle');
  // Running-run summaries per thread (sidebar indicators + task progress).
  // A present entry means "running"; the summary carries taskProgress when
  // the run has produced a task list.
  const [sidebarRuns, setSidebarRuns] = useState<
    Record<string, AgentRunSummary | null>
  >({});
  const [error, setError] = useState<string>();
  const [modelReady, setModelReady] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StudioThread>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();
  // Latest authoritative task snapshot for the viewed thread; null while the
  // thread has no task list. Canonical state stays server-side (Mastra task
  // store + run events); this only mirrors the newest snapshot.
  const [threadTasks, setThreadTasks] = useState<ThreadTaskState | null>(null);
  // Bounded last task-tool failure surfaced inside the dock; cleared by
  // the next snapshot and on thread switches.
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [taskDockOpen, setTaskDockOpen] = useState(false);

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

    if (event.type === 'task-list') {
      // Snapshots are authoritative and replace the previous list, so
      // replayed and live snapshots resolve to the latest state without
      // duplicating rows. An empty snapshot clears the list; malformed
      // snapshots are ignored.
      const tasks = parseTaskListPayload(event.payload);
      if (tasks) {
        const hadNoSnapshot = !hasTaskSnapshotRef.current;
        hasTaskSnapshotRef.current = tasks.length > 0;
        setTaskNotice(null);
        setThreadTasks((current) =>
          applyTaskSnapshot(current, tasks, event.createdAt),
        );
        // A fresh (non-empty) snapshot expands the dock on wide screens
        // unless the user collapsed it before; their preference wins over
        // auto-open.
        if (
          hadNoSnapshot &&
          tasks.length > 0 &&
          !readTaskDockCollapsedPreference()
        ) {
          setTaskDockOpen(
            typeof window === 'undefined' || window.innerWidth > 1080,
          );
        }
      }
      return;
    }

    if (
      event.type === 'tool-error' &&
      isTaskToolName(event.payload.toolName as string | undefined)
    ) {
      // A failed task call never renders as a timeline card, but it must
      // not be invisible either: surface a bounded notice in the dock so
      // the operator can see why the list stopped updating.
      const detail = event.payload.error;
      const text =
        typeof detail === 'string'
          ? detail
          : detail instanceof Error
            ? detail.message
            : 'Task tool failed';
      setTaskNotice(text.slice(0, 300));
      return;
    }

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
      // The server reroutes task tools into `task-list` snapshots and
      // bounded task `tool-error` notices (handled above); skipping them
      // here keeps a stray legacy event from rendering a task_write JSON
      // card in the timeline.
      if (isTaskToolName(event.payload.toolName as string | undefined)) {
        return;
      }
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
            ? appendErrorDetail(message, detail)
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
      setActiveAssistantId(assistantId);
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
        setActiveAssistantId(null);
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

  // Thread switches update the ref from the COMMITTED render (layout
  // effect), never from a render pass that React may still discard under
  // concurrent rendering — async guards must compare against the thread
  // actually on screen, not a possibly-abandoned render.
  useLayoutEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);

  // Instant jumps only: an animated jump emits intermediate scroll events
  // far from the bottom and competes with the streaming follow for the
  // viewport. `behavior: 'auto'` applies synchronously, so syncing the
  // direction baseline to the destination afterwards guarantees the jump's
  // own scroll event is never misread as upward user scrolling.
  const scrollToConversationBottom = useCallback(() => {
    const element = conversationRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    previousScrollTopRef.current = element.scrollTop;
  }, []);

  const setPinned = useCallback((pinned: boolean) => {
    isPinnedRef.current = pinned;
    setIsPinned(pinned);
  }, []);

  const handleConversationScroll = useCallback(() => {
    const element = conversationRef.current;
    if (!element) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    const previousScrollTop = previousScrollTopRef.current;
    previousScrollTopRef.current = scrollTop;
    // Upward movement is always the user reading history — detach even
    // inside the re-attach band, so a small scroll-up during streaming is
    // never yanked back by the next delta. Programmatic jumps only ever
    // move down, so upward movement cannot be our own scroll.
    if (scrollTop < previousScrollTop) {
      setPinned(false);
      return;
    }
    // Near-bottom proximity re-attaches the follow; it is never a detach
    // condition, so a downward scroll event far from the bottom (e.g. a
    // jump still in flight) cannot unpin the follow.
    if (scrollHeight - scrollTop - clientHeight <= CHAT_PIN_THRESHOLD_PX) {
      setPinned(true);
    }
  }, [setPinned]);

  // Streaming follows the output only while the user is pinned to the
  // bottom; an unpinned user reading history is never scrolled (each delta
  // re-renders `messages`, so gating the effect here is what stops the old
  // forced-scroll behavior). Instant (`auto`) following keeps high-frequency
  // deltas from stacking competing smooth scroll animations — the source of
  // the earlier stutter.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    scrollToConversationBottom();
  }, [messages, scrollToConversationBottom]);

  // A thread switch (or first load) always lands at the latest message.
  useEffect(() => {
    setPinned(true);
    scrollToConversationBottom();
  }, [threadId, scrollToConversationBottom, setPinned]);

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
            // Rebuild historical task state from the persisted task tool
            // results (Mastra Memory is the source of truth once the run
            // registry no longer holds the thread's run). Last valid
            // snapshot wins, matching the live event stream's semantics.
            let restoredTasks = null as ThreadTaskState['tasks'] | null;
            for (const message of storedMessages) {
              const snapshot = tasksFromRestoredParts(message.parts);
              if (snapshot) restoredTasks = snapshot;
            }
            setThreadTasks(
              restoredTasks ? { tasks: restoredTasks } : null,
            );
            hasTaskSnapshotRef.current = restoredTasks !== null;
            // A restored list re-opens the dock on wide screens unless the
            // user explicitly collapsed it before.
            setTaskDockOpen(
              restoredTasks !== null &&
                !readTaskDockCollapsedPreference() &&
                window.innerWidth > 1080,
            );
          }
        } catch {
          if (!cancelled) {
            setMessages([]);
            setThreadTasks(null);
            hasTaskSnapshotRef.current = false;
          }
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
      // point thread B's Stop button at thread A's run. Task state is
      // scoped the same way — thread B starts from its own Memory-derived
      // snapshot, never thread A's dock contents.
      setActiveRun(null);
      setActiveAssistantId(null);
      setSubscriptionState('idle');
      lastTerminalRef.current = null;
      setThreadTasks(null);
      setTaskNotice(null);
      setTaskDockOpen(false);
      hasTaskSnapshotRef.current = false;
    };
  }, [agentId, attachToRun, refreshThreads, resourceId, threadId]);

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
        const next: Record<string, AgentRunSummary | null> = {};
        for (const run of runs) next[run.threadId] = run;
        const previous = sidebarRunsRef.current;
        const completedElsewhere = Object.keys(previous).some(
          (id) => !next[id],
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
    if (runActive || !modelReady) return;

    // Error chips stay visible until dismissed but never consume an
    // attachment slot, so rejected files cannot block further adds.
    const activeCount = uploads.filter(
      (upload) => upload.status !== 'error',
    ).length;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - activeCount;
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
      runActive ||
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
    const runPrompt =
      prompt || attachmentViews[0]?.filename || 'Attachment';
    const runContent = buildUserMessageContent(prompt, readyUploads);
    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const sentInput = input;

    // Sending a message is an explicit "show me the reply" intent: re-attach
    // the follow even if the user had scrolled up while reading.
    setPinned(true);
    setMessages((current) => [
      ...current,
      {
        id: userMessageId,
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
    setSubscriptionState('connecting');

    try {
      const run = await startRun({
        agentId,
        threadId,
        prompt: runPrompt,
        content: runContent,
      });

      // The user may have switched threads while the start request was in
      // flight; the resolved run belongs to the thread this send started
      // from, so attaching here would stream its events (text, tasks) into
      // the newly viewed thread and disable its composer. Drop it — the
      // run keeps executing server-side and remains visible in the sidebar.
      if (threadRef.current !== threadId) return;

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
        if (threadRef.current !== threadId) return;
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== userMessageId && message.id !== assistantId,
          ),
        );
        attachToRun(reason.run);
        return;
      }

      // A failure of a thread the user already left must not surface in
      // (or restore drafted input into) the thread now being viewed.
      if (threadRef.current !== threadId) return;
      const detail =
        reason instanceof Error
          ? reason.message
          : 'Unknown connection error';

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? appendErrorDetail(message, `Could not complete request. ${detail}`)
            : message,
        ),
      );
      // The send failed before any run existed: put the drafted input and
      // the prepared attachments back so retrying does not force the user
      // to re-pick and re-process every file.
      setInput(sentInput);
      setUploads(
        readyUploads.map((prepared) => ({
          id: prepared.id,
          filename: prepared.filename,
          kind: prepared.kind,
          status: 'ready' as const,
          prepared,
        })),
      );
      setSubscriptionState('idle');
    }
  };

  const stop = async () => {
    const run = activeRun;
    if (!run) return;
    const stopThreadId = threadId;
    try {
      await cancelRun(run.id);
      // Optimistic feedback: the server abort lands at the next engine step
      // boundary (an in-flight tool call keeps running until it finishes),
      // so flip pending tool cards to `interrupted` immediately. A late
      // tool-result event still upserts over this state.
      const assistantId = activeAssistantId;
      if (assistantId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId && message.parts?.length
              ? { ...message, parts: interruptRunningToolParts(message.parts) }
              : message,
          ),
        );
      }
    } catch (reason) {
      // The user may have switched threads while the cancel request was in
      // flight; a stale thread's stop failure must not banner the view.
      if (threadRef.current !== stopThreadId) return;
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

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      // Unsupported clipboard files flow through addFiles too, so paste
      // surfaces the same error chips as drop and the file picker instead
      // of silently dropping them.
      addFiles(files);
    }
  };

  const dragEnterForm = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Count dragenter/dragleave crossings so the highlight survives moving
    // across child elements instead of flickering on every boundary.
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const dragOverForm = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragOver(true);
  };

  const dragLeaveForm = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const dropForm = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  const toggleTaskDock = useCallback(() => {
    setTaskDockOpen((open) => {
      const next = !open;
      try {
        if (next) {
          window.localStorage.removeItem(TASK_DOCK_COLLAPSED_KEY);
        } else {
          window.localStorage.setItem(TASK_DOCK_COLLAPSED_KEY, '1');
        }
      } catch {
        // Preference persistence is best-effort; the dock still toggles.
      }
      return next;
    });
  }, []);

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
    <div
      className={`chat-studio-shell${
        taskDockOpen &&
        threadTasks &&
        threadTasks.tasks.length > 0
          ? ' has-task-dock'
          : ''
      }`}
    >
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
                    {sidebarRuns[thread.id]?.taskProgress
                      ? ` ${sidebarRuns[thread.id]!.taskProgress!.completed}/${sidebarRuns[thread.id]!.taskProgress!.total}`
                      : ''}
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
            {threadTasks && threadTasks.tasks.length > 0 && !taskDockOpen && (
              <TaskDock
                tasks={threadTasks.tasks}
                updatedAt={threadTasks.updatedAt}
                notice={taskNotice ?? undefined}
                open={false}
                onToggle={toggleTaskDock}
              />
            )}
            {/* Task tool failures must stay visible even when no dock body
                exists to host them: a rejected first task_write leaves no
                snapshot, and the collapsed pill hides the dock body. */}
            {taskNotice &&
              !(
                taskDockOpen &&
                threadTasks &&
                threadTasks.tasks.length > 0
              ) && (
                <p
                  className="chat-task-notice-topbar"
                  role="status"
                >
                  <span aria-hidden="true">⚠</span> {taskNotice}
                </p>
              )}
          </div>
        </header>

        <section
          ref={conversationRef}
          onScroll={handleConversationScroll}
          aria-live="polite"
          className={`chat-conversation ${
            messages.length ? 'has-messages' : ''
          }`}
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
              {skills.length > 0 ? (
                <div
                  className="chat-welcome-skills"
                  role="group"
                  aria-label="Skills for this agent"
                >
                  {skills.slice(0, 4).map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      className="chat-welcome-skill"
                      title={skill.description || undefined}
                      onClick={() => {
                        applySelection(skill.name);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span aria-hidden="true">/</span>
                      {skill.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="chat-welcome-hint">
                / for skills · attach files · paste images
              </p>
            </div>
          ) : (
            <div className="chat-message-list">
              {messages.map((message) => {
                const partGroups =
                  message.role === 'assistant' && message.parts?.length
                    ? groupAssistantParts(
                        withoutTaskToolParts(message.parts),
                      )
                    : null;
                const copyText = message.parts?.length
                  ? textFromAssistantParts(message.parts)
                  : message.content;

                // A restored turn whose only parts were task tools renders
                // as an empty bubble once they move to the Tasks dock.
                if (
                  message.role === 'assistant' &&
                  message.id !== activeAssistantId &&
                  !message.content &&
                  !message.attachments?.length &&
                  !(partGroups && partGroups.length > 0)
                ) {
                  return null;
                }

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
                      <time>{formatMessageTime(message.createdAt)}</time>
                    </div>

                    {partGroups ? (
                      partGroups.map((group) =>
                        group.kind === 'tools' ? (
                          <div
                            className="chat-tool-timeline"
                            key={`tools-${group.parts[0]?.id}`}
                          >
                            {group.parts.map((tool) => (
                              <ToolCallCard
                                key={tool.id}
                                tool={tool}
                                collapseByDefault={agentId === QA_WEB_AGENT_ID}
                              />
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

                    {partGroups &&
                      !message.content &&
                      runActive &&
                      message.id === activeAssistantId && (
                        <TypingIndicator />
                      )}

                    {message.role === 'assistant' && copyText && (
                      <div className="chat-message-actions">
                        <button
                          type="button"
                          className={
                            copiedMessageId === message.id ? 'copied' : ''
                          }
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(copyText)
                              .then(() => {
                                setCopiedMessageId(message.id);
                                window.setTimeout(() => {
                                  setCopiedMessageId((current) =>
                                    current === message.id ? null : current,
                                  );
                                }, 2000);
                              });
                          }}
                        >
                          {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              {!isPinned && (
                <button
                  type="button"
                  className="chat-jump-latest"
                  onClick={() => {
                    setPinned(true);
                    scrollToConversationBottom();
                  }}
                  aria-label="Jump to latest message"
                >
                  ↓
                </button>
              )}
            </div>
          )}
        </section>
        <p className="studio-sr-only" role="status">
          {runActive ? 'Assistant is responding…' : 'Assistant is idle'}
        </p>

          <div className="chat-composer-wrap">
              {error && <div className="studio-alert studio-alert-error">{error}</div>}
              {!modelReady && !loading && <div className="studio-alert studio-alert-error">The agent server returned no models. Set <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code>, and <code>LLM_DEFAULT_MODEL</code> in <code>agent/.env</code>, then restart the agent server.</div>}
              <form className={`chat-composer${dragOver ? ' drag-over' : ''}`} onSubmit={submit} onDragOver={dragOverForm} onDragEnter={dragEnterForm} onDragLeave={dragLeaveForm} onDrop={dropForm}>
                <div className="chat-composer__input">
                  {uploads.length > 0 && <div className="chat-upload-row" role="list" aria-label="Pending attachments">{uploads.map((upload) => <span className={`chat-upload-chip ${upload.status}`} key={upload.id} role="listitem"><span aria-hidden="true">{upload.kind === 'image' ? '▣' : upload.kind === 'pdf' ? '⎘' : '≡'}</span><span className="chat-upload-name">{upload.filename}{upload.prepared?.kind === 'pdf' ? ` (${upload.prepared.pages.length} pages)` : ''}</span>{upload.status === 'preparing' && <small>processing…</small>}{upload.status === 'error' && upload.error && <small>{upload.error}</small>}<button type="button" onClick={() => removeUpload(upload.id)} aria-label={`Remove ${upload.filename}`}>×</button></span>)}</div>}
                  {commandOpen && filteredSkills.length > 0 ? <CommandMenu commands={filteredSkills} activeIndex={commandIndex} onSelect={applySelection} /> : null}
                  <textarea ref={textareaRef} value={input} onChange={(event) => { const value = event.target.value; setInput(value); const isCommand = isCommandInput(value); setCommandOpen(isCommand); if (isCommand) setCommandIndex(0); }} onKeyDown={keyDown} onPaste={paste} role="combobox" aria-expanded={commandOpen && filteredSkills.length > 0} aria-controls={commandOpen && filteredSkills.length > 0 ? 'chat-command-menu' : undefined} aria-autocomplete="list" placeholder={modelReady ? `Message ${currentAgent?.name || agentId}…` : 'Configure the server model first…'} disabled={!modelReady || runActive} rows={1} />
                </div>
                <footer>
                  <div>
                    <input ref={fileInputRef} type="file" multiple hidden accept={ATTACHMENT_ACCEPT_ATTR} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
                    <button className="chat-attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={!modelReady || runActive} aria-label="Attach files" title="Attach files">＋ Attach</button>
                    <span className="chat-memory-chip">◇ Memory</span>
                    {agentId === QA_WEB_AGENT_ID && <span className="chat-memory-chip">◎ Browser</span>}
                    {agentId === QA_ANDROID_AGENT_ID && <span className="chat-memory-chip">▷ Maestro</span>}
                  </div>
                  <div>
                    {runActive && subscriptionState !== 'connected' ? <small>Connecting to the running conversation…</small> : <small>Shift + Enter for new line</small>}
                    {runActive ? <button className="chat-stop-button" type="button" onClick={() => void stop()} aria-label="Stop generation">■</button> : <button className="chat-send-button" type="submit" disabled={(!input.trim() && readyUploads.length === 0) || preparingUploads || !modelReady} aria-label="Send message">↑</button>}
                  </div>
                </footer>
              </form>
          </div>
      </main>
      {taskDockOpen && threadTasks && threadTasks.tasks.length > 0 && (
        <TaskDock
          tasks={threadTasks.tasks}
          updatedAt={threadTasks.updatedAt}
          notice={taskNotice ?? undefined}
          open
          onToggle={toggleTaskDock}
        />
      )}
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
