// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunConflictError } from '@/lib/agent-runs';

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

let container: HTMLDivElement;
let root: Root | null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function remount(): Promise<void> {
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
        initialThreadId={activeThreadId}
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
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue(threads);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue(runningRun('run_20260101000000_00000001', activeThreadId));
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);
  cancelRun.mockResolvedValue({
    ...runningRun('run_20260101000000_00000001', activeThreadId),
    status: 'cancelled' as const,
  });
  // By default the observation stays open: the run keeps executing.
  observeRunEvents.mockImplementation(
    () => new Promise<void>(() => undefined),
  );

  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollTo = vi.fn();

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

describe('ChatStudio run reconnection', () => {
  it('discovers a running run on mount and replays its events without starting a new one', async () => {
    getActiveRun.mockResolvedValue(
      runningRun('run_20260101000000_000000aa', activeThreadId, 'original task'),
    );
    observeRunEvents.mockImplementation(
      async (_runId: string, { onEvent }: { onEvent: (event: unknown) => void }) => {
        onEvent({
          sequence: 0,
          type: 'text-delta',
          payload: { text: 'reconnected partial' },
          createdAt: '',
        });
      },
    );

    await remount();

    expect(getActiveRun).toHaveBeenCalledWith('main-agent', activeThreadId);
    expect(startRun).not.toHaveBeenCalled();
    expect(observeRunEvents).toHaveBeenCalledWith(
      'run_20260101000000_000000aa',
      expect.objectContaining({ offset: 0 }),
    );
    // Mastra persists the user message only at turn end, so the in-flight
    // prompt is synthesized from the run record.
    expect(container.textContent).toContain('original task');
    expect(container.textContent).toContain('reconnected partial');
    expect(container.querySelector('.chat-welcome')).toBeNull();
  });

  it('renders replayed tool progress before any text delta arrives', async () => {
    getActiveRun.mockResolvedValue(
      runningRun('run_20260101000000_000000dd', activeThreadId, 'search task'),
    );
    observeRunEvents.mockImplementation(
      async (_runId: string, { onEvent }: { onEvent: (event: unknown) => void }) => {
        onEvent({
          sequence: 0,
          type: 'tool-call',
          payload: { toolCallId: 'tc-1', toolName: 'search_web', args: {} },
          createdAt: '',
        });
      },
    );

    await remount();

    // The assistant placeholder created on attach gives tool events a
    // message to render under instead of the empty welcome state.
    expect(container.querySelector('.chat-welcome')).toBeNull();
    expect(container.textContent).toContain('search task');
    // toolName is displayed with underscores replaced by spaces.
    expect(container.textContent).toContain('search web');
  });

  it('does not duplicate the prompt when Memory already persisted the turn', async () => {
    listThreadMessages.mockResolvedValue([
      {
        id: 'mem-user-1',
        role: 'user',
        content: 'already stored prompt',
        createdAt: 1,
      },
      {
        id: 'mem-assistant-1',
        role: 'assistant',
        content: 'stored answer',
        createdAt: 2,
      },
    ]);
    getActiveRun.mockResolvedValue(
      runningRun(
        'run_20260101000000_000000ee',
        activeThreadId,
        'already stored prompt',
      ),
    );
    observeRunEvents.mockImplementation(async () => undefined);

    await remount();

    const occurrences =
      container.textContent?.split('already stored prompt').length ?? 0;
    expect(occurrences).toBe(2); // one split prefix + one match
  });

  it('navigates to another thread while the current run keeps executing', async () => {
    await enterComposerText('long task');
    await submitComposer();

    expect(observeRunEvents).toHaveBeenCalled();

    const otherRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.chat-thread-row > button'),
    ).find((button) => button.textContent?.includes('Other thread'));
    expect(otherRow).toBeDefined();
    expect(otherRow!.disabled).toBe(false);

    await act(async () => {
      otherRow!.click();
      await Promise.resolve();
    });

    expect(router.push).toHaveBeenCalled();
    // Unmounting must not cancel the run; only the observation is dropped.
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('resets run state when switching threads so thread B is not blocked by thread A', async () => {
    await enterComposerText('long task');
    await submitComposer();

    // Thread A has a running run: composer disabled, Stop button visible.
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea')!.disabled,
    ).toBe(true);
    expect(
      container.querySelector('[aria-label="Stop generation"]'),
    ).not.toBeNull();

    // router.push re-renders the same ChatStudio instance with new props
    // (no remount key) — simulate exactly that.
    startRun.mockImplementation(async () =>
      runningRun('run_20260101000000_00000002', otherThreadId, 'next task'),
    );
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

    // The stale run from thread A must not keep thread B's composer
    // disabled or show a Stop button that would cancel thread A's run.
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea')!.disabled,
    ).toBe(false);
    expect(
      container.querySelector('[aria-label="Stop generation"]'),
    ).toBeNull();
    expect(cancelRun).not.toHaveBeenCalled();

    // Thread B accepts a new prompt immediately.
    await enterComposerText('next task');
    await submitComposer();

    const lastCall = startRun.mock.calls[startRun.mock.calls.length - 1];
    expect(lastCall[0]).toEqual(
      expect.objectContaining({ threadId: otherThreadId }),
    );
  });

  it('attaches to the existing run when a duplicate start is rejected', async () => {
    startRun.mockRejectedValueOnce(
      new RunConflictError(
        runningRun('run_20260101000000_000000bb', activeThreadId, 'first tab task'),
        'A run is already active for this thread',
      ),
    );

    await enterComposerText('duplicate');
    await submitComposer();

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(observeRunEvents).toHaveBeenCalledWith(
      'run_20260101000000_000000bb',
      expect.objectContaining({ offset: 0 }),
    );
    // The optimistic duplicate prompt was rolled back; the existing run's
    // prompt is re-synthesized from the run record instead.
    expect(container.textContent).not.toContain('duplicate');
    expect(container.textContent).toContain('first tab task');
  });

  it('refreshes the thread list as soon as a run starts', async () => {
    const before = listAgentThreads.mock.calls.length;
    await enterComposerText('long task');
    await submitComposer();

    expect(startRun).toHaveBeenCalledTimes(1);
    // The server creates the Memory thread before responding, so one
    // refresh surfaces the new thread immediately (sidebar + title).
    expect(listAgentThreads.mock.calls.length).toBeGreaterThan(before);
  });

  it('cancels the active run by id from the stop button', async () => {
    await enterComposerText('stoppable');
    await submitComposer();

    const stopButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop generation"]',
    );
    expect(stopButton).not.toBeNull();
    await act(async () => {
      stopButton!.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(cancelRun).toHaveBeenCalledWith('run_20260101000000_00000001');
  });

  it('shows the running indicator for threads with active runs', async () => {
    listActiveRuns.mockResolvedValue([
      runningRun('run_20260101000000_000000cc', otherThreadId),
    ]);

    await remount();

    const otherRow = Array.from(
      container.querySelectorAll('.chat-thread-row'),
    ).find((row) => row.textContent?.includes('Other thread'));
    expect(otherRow?.querySelector('.chat-thread-running')).not.toBeNull();
    expect(otherRow?.textContent).toContain('Running');
  });
});
