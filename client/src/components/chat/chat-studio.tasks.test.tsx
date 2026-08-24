// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listAgentSkills,
  listAgentThreads,
  listThreadMessages,
  startRun,
  getActiveRun,
  listActiveRuns,
  cancelRun,
  observeRunEvents,
  router,
} = vi.hoisted(() => ({
  listAgentSkills: vi.fn(),
  listAgentThreads: vi.fn(),
  listThreadMessages: vi.fn(),
  startRun: vi.fn(),
  getActiveRun: vi.fn(),
  listActiveRuns: vi.fn(),
  cancelRun: vi.fn(),
  observeRunEvents: vi.fn(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/agents/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@/components/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/studio/resizable-sidebar', () => ({
  ResizableSidebar: ({
    children,
  }: {
    children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
  }) => <aside>{children(false, vi.fn())}</aside>,
}));
vi.mock('@/components/ui/brand-mark', () => ({ BrandMark: () => null }));
vi.mock('@/lib/agent-skills', () => ({ listAgentSkills }));
vi.mock('@/lib/memory-threads', () => ({
  listAgentThreads,
  listThreadMessages,
  removeThread: vi.fn(),
  renameThread: vi.fn(),
}));
vi.mock('@/lib/agent-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-runs')>();
  return {
    ...actual,
    startRun,
    getActiveRun,
    listActiveRuns,
    cancelRun,
    observeRunEvents,
  };
});
vi.mock('@/lib/model-registry', () => ({
  loadModelRegistry: vi.fn(async () => ({
    configured: true,
    displayName: 'Test model',
    defaultModel: 'test-model',
    models: ['test-model'],
  })),
}));
vi.mock('@/lib/stored-agents', () => ({
  ensureStoredAgentUsesServerGateway: vi.fn(async () => undefined),
  listAllAgents: vi.fn(async () => [
    { id: 'main-agent', name: 'Main agent', source: 'code' },
  ]),
}));

import { ChatStudio } from './chat-studio';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const activeThreadId = 'main-agent-local-user-active';
const otherThreadId = 'main-agent-local-user-other';
const threads = [
  {
    id: activeThreadId,
    title: 'Active thread',
    agentId: 'main-agent',
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: otherThreadId,
    title: 'Other thread',
    agentId: 'main-agent',
    createdAt: 1,
    updatedAt: 1,
  },
];

const runningRun = (id: string, threadId: string, prompt = 'run prompt') => ({
  id,
  resourceId: 'local-user',
  agentId: 'main-agent',
  threadId,
  prompt,
  status: 'running' as const,
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const tasks = (statuses: ('pending' | 'in_progress' | 'completed')[]) =>
  statuses.map((status, index) => ({
    id: `task_${index + 1}`,
    content: `Task ${index + 1}`,
    activeForm: `Working on task ${index + 1}`,
    status,
  }));

let container: HTMLDivElement;
let root: Root | null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function remount(
  threadId: string = activeThreadId,
): Promise<void> {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  act(() => {
    next.render(
      <ChatStudio
        resourceId="local-user"
        initialAgentId="main-agent"
        initialThreadId={threadId}
      />,
    );
  });
  await flushEffects();
}

async function enterComposerText(value: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  expect(textarea).not.toBeNull();
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    valueSetter!.call(textarea, value);
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function submitComposer(): Promise<void> {
  const form = container.querySelector<HTMLFormElement>('.chat-composer');
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  await flushEffects();
}

beforeEach(async () => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.innerWidth = 1440;
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue(threads);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue(
    runningRun('run_20260101000000_00000001', activeThreadId),
  );
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);
  cancelRun.mockResolvedValue({
    ...runningRun('run_20260101000000_00000001', activeThreadId),
    status: 'cancelled' as const,
  });
  observeRunEvents.mockImplementation(
    () => new Promise<void>(() => undefined),
  );

  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn();

  act(() => {
    root!.render(
      <ChatStudio
        resourceId="local-user"
        initialAgentId="main-agent"
        initialThreadId={activeThreadId}
      />,
    );
  });
  await flushEffects();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ChatStudio task dock', () => {
  it('renders the dock from a live task-list event', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress', 'pending', 'pending']) },
        createdAt: '',
      });
    });

    expect(container.querySelector('.chat-task-dock')).not.toBeNull();
    expect(container.textContent).toContain('0/3');
    expect(container.textContent).toContain('Working on task 1');
  });

  it('resolves replayed snapshots to the latest state without duplicates', async () => {
    getActiveRun.mockResolvedValue(
      runningRun('run_20260101000000_000000aa', activeThreadId, 'reload task'),
    );
    observeRunEvents.mockImplementation(
      async (
        _runId: string,
        { onEvent }: { onEvent: (event: unknown) => void },
      ) => {
        onEvent({
          sequence: 0,
          type: 'task-list',
          payload: { tasks: tasks(['pending', 'pending']) },
          createdAt: '',
        });
        onEvent({
          sequence: 5,
          type: 'task-list',
          payload: {
            tasks: tasks(['completed', 'in_progress', 'pending']),
          },
          createdAt: '',
        });
      },
    );

    await remount();

    const dock = container.querySelector('.chat-task-dock');
    expect(dock).not.toBeNull();
    const items = dock!.querySelectorAll('.chat-task-item');
    expect(items).toHaveLength(3);
    expect(container.textContent).toContain('1/3');
  });

  it('does not render task tool cards in the timeline', async () => {
    getActiveRun.mockResolvedValue(
      runningRun('run_20260101000000_000000bb', activeThreadId, 'qa task'),
    );
    observeRunEvents.mockImplementation(
      async (
        _runId: string,
        { onEvent }: { onEvent: (event: unknown) => void },
      ) => {
        onEvent({
          sequence: 0,
          type: 'tool-call',
          payload: {
            toolCallId: 'tc-task',
            toolName: 'task_write',
            args: { tasks: [] },
          },
          createdAt: '',
        });
        onEvent({
          sequence: 1,
          type: 'tool-call',
          payload: {
            toolCallId: 'tc-browser',
            toolName: 'browser_navigate',
            args: { url: 'https://example.com' },
          },
          createdAt: '',
        });
      },
    );

    await remount();

    expect(container.textContent).not.toContain('task write');
    expect(container.textContent).toContain('browser navigate');
  });

  it('restores historical task state from Memory parts and hides task cards', async () => {
    listThreadMessages.mockResolvedValue([
      {
        id: 'mem-assistant-1',
        role: 'assistant',
        content: '',
        createdAt: 2,
        parts: [
          {
            type: 'tool' as const,
            id: 'p1',
            toolCallId: 'tc-1',
            toolName: 'task_write',
            status: 'complete' as const,
            result: {
              content: 'ok',
              tasks: tasks(['completed', 'completed', 'pending']),
              isError: false,
            },
          },
          {
            type: 'tool' as const,
            id: 'p2',
            toolCallId: 'tc-2',
            toolName: 'search_web',
            status: 'complete' as const,
            result: 'found',
          },
        ],
      },
    ]);

    await remount();

    // Dock recovered from the persisted task tool result.
    expect(container.querySelector('.chat-task-dock')).not.toBeNull();
    expect(container.textContent).toContain('2/3');
    // The task tool part does not render as a tool card; the real tool does.
    expect(container.textContent).not.toContain('task write');
    expect(container.textContent).toContain('search web');
  });

  it('does not leak task state between threads', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress', 'pending']) },
        createdAt: '',
      });
    });
    expect(container.querySelector('.chat-task-dock')).not.toBeNull();

    // Switch to thread B (same component instance, new props).
    await act(async () => {
      root!.render(
        <ChatStudio
          resourceId="local-user"
          initialAgentId="main-agent"
          initialThreadId={otherThreadId}
        />,
      );
    });
    await flushEffects();

    expect(container.querySelector('.chat-task-dock')).toBeNull();
    expect(container.querySelector('.chat-task-pill')).toBeNull();
  });

  it('drops a run that resolves after the user switched threads mid-start', async () => {
    // The send handler awaits startRun outside any effect; if the user
    // switches threads during that round-trip, the resolved run belongs to
    // the OLD thread and must never install a subscription into the new
    // thread's view (dock snapshots, text deltas, disabled composer).
    let resolveStart!: (value: unknown) => void;
    startRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );

    await enterComposerText('complex work');
    await submitComposer();

    // Switch to thread B while thread A's startRun is still in flight.
    await act(async () => {
      root!.render(
        <ChatStudio
          resourceId="local-user"
          initialAgentId="main-agent"
          initialThreadId={otherThreadId}
        />,
      );
    });
    await flushEffects();
    observeRunEvents.mockClear();

    // Thread A's run starts successfully — after the switch.
    await act(async () => {
      resolveStart(
        runningRun('run_20260824000000_000000ee', activeThreadId),
      );
      await Promise.resolve();
    });
    await flushEffects();

    // No subscription for thread A's run is installed into thread B's view.
    expect(observeRunEvents).not.toHaveBeenCalled();
    expect(container.querySelector('.chat-task-dock')).toBeNull();
    expect(container.querySelector('.chat-task-pill')).toBeNull();
  });

  it('hides the dock when the model clears the task list', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress', 'pending']) },
        createdAt: '',
      });
    });
    expect(container.querySelector('.chat-task-dock')).not.toBeNull();

    // task_write({ tasks: [] }) — the cleared snapshot must empty the dock.
    await act(async () => {
      events.onEvent({
        sequence: 1,
        type: 'task-list',
        payload: { tasks: [] },
        createdAt: '',
      });
    });
    expect(container.querySelector('.chat-task-dock')).toBeNull();
    expect(container.querySelector('.chat-task-pill')).toBeNull();
  });

  it('surfaces a bounded dock notice when a task tool fails', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress']) },
        createdAt: '',
      });
      events.onEvent({
        sequence: 1,
        type: 'tool-error',
        payload: {
          toolCallId: 'tc-task',
          toolName: 'task_update',
          error: `Task not found: ${'x'.repeat(2_000)}`,
        },
        createdAt: '',
      });
    });

    const notice = container.querySelector('.chat-task-dock-notice');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('Task not found');
    expect(notice!.textContent!.length).toBeLessThan(600);
    // Task tool errors never render as timeline tool cards.
    expect(container.textContent).not.toContain('task update');
  });

  it('collapses to the topbar pill and persists the preference', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress', 'pending']) },
        createdAt: '',
      });
    });

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse task panel"]',
    );
    expect(collapse).not.toBeNull();
    await act(async () => {
      collapse!.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.chat-task-dock')).toBeNull();
    const pill = container.querySelector<HTMLButtonElement>('.chat-task-pill');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain('0/2');
    expect(window.localStorage.getItem('chekku-task-dock-collapsed')).toBe(
      '1',
    );

    // Reopening clears the collapsed preference.
    await act(async () => {
      pill!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.chat-task-dock')).not.toBeNull();
    expect(window.localStorage.getItem('chekku-task-dock-collapsed')).toBeNull();
  });

  it('keeps text streaming and terminal behavior intact alongside tasks', async () => {
    await enterComposerText('complex work');
    await submitComposer();

    const events = observeRunEvents.mock.calls[0]![1] as {
      onEvent: (event: unknown) => void;
    };
    await act(async () => {
      events.onEvent({
        sequence: 0,
        type: 'text-delta',
        payload: { text: 'Starting the plan' },
        createdAt: '',
      });
      events.onEvent({
        sequence: 1,
        type: 'task-list',
        payload: { tasks: tasks(['in_progress']) },
        createdAt: '',
      });
    });

    expect(container.textContent).toContain('Starting the plan');
    expect(container.textContent).toContain('1/1');
    // The malformed snapshot is ignored without breaking the run view.
    await act(async () => {
      events.onEvent({
        sequence: 2,
        type: 'task-list',
        payload: { tasks: 'garbage' },
        createdAt: '',
      });
    });
    expect(container.querySelector('.chat-task-dock')).not.toBeNull();
    expect(container.textContent).toContain('1/1');
  });

  it('shows task progress in the sidebar running indicator', async () => {
    // Another thread's run carries taskProgress on its summary; the poll
    // surfaces it next to the Running status in that thread's row.
    listActiveRuns.mockResolvedValue([
      {
        ...runningRun('run_20260821170000_000000dd', otherThreadId),
        taskProgress: { completed: 2, total: 5 },
      },
    ]);

    await remount();

    const otherRow = Array.from(
      container.querySelectorAll('.chat-thread-row'),
    ).find((row) => row.textContent?.includes('Other thread'));
    expect(otherRow?.querySelector('.chat-thread-status')?.textContent).toContain(
      'Running 2/5',
    );
  });
});
