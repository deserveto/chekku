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
  observeRunEvents,
  router,
} = vi.hoisted(() => ({
  listAgentSkills: vi.fn(),
  listAgentThreads: vi.fn(),
  listThreadMessages: vi.fn(),
  startRun: vi.fn(),
  getActiveRun: vi.fn(),
  listActiveRuns: vi.fn(),
  observeRunEvents: vi.fn(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/agents/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@/components/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => (
    <div className="md">{content}</div>
  ),
}));
vi.mock('@/components/studio/resizable-sidebar', () => ({
  ResizableSidebar: ({
    children,
  }: {
    children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
  }) => <aside>{children(false, vi.fn())}</aside>,
}));
vi.mock('@/components/ui/brand-mark', () => ({ BrandMark: () => null }));
vi.mock('@/components/ui/confirmation-dialog', () => ({
  ConfirmationDialog: () => null,
}));
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

type StreamEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

let container: HTMLDivElement;
let root: Root | null;
let scrollToMock: ReturnType<typeof vi.fn>;

/**
 * Manual run-event pump: observeRunEvents captures onEvent so tests can emit
 * additional stream events after simulating user scrolling.
 */
let pump: ((event: StreamEvent) => void) | null = null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pumpEvents(events: StreamEvent[]): Promise<void> {
  await act(async () => {
    for (const event of events) {
      pump?.(event);
    }
    await Promise.resolve();
  });
}

async function submitMessage(prompt: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  expect(textarea).not.toBeNull();
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  expect(valueSetter).toBeDefined();

  await act(async () => {
    valueSetter!.call(textarea, prompt);
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });

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

function conversation(): HTMLElement {
  const element = container.querySelector<HTMLElement>('.chat-conversation');
  expect(element).not.toBeNull();
  return element!;
}

/**
 * Simulate a scroll position inside the conversation container. jsdom has no
 * layout, so scrollHeight/clientHeight/scrollTop are backed by instance
 * properties that must be redefined per scenario.
 */
function setScrollGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, {
      configurable: true,
      value,
    });
  }
}

async function fireScroll(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue([]);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue({
    id: 'run_autoscroll_test',
    resourceId: 'local-user',
    agentId: 'main-agent',
    threadId: activeThreadId,
    status: 'running',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);

  let sequence = 0;
  pump = null;
  observeRunEvents.mockImplementation(
    (_runId: string, { onEvent }: { onEvent: (event: unknown) => void }) => {
      pump = (event) => {
        onEvent({
          sequence: sequence++,
          type: event.type,
          payload: event.payload ?? {},
          createdAt: new Date().toISOString(),
        });
      };
      // The subscription stays open; unmount aborts it.
      return new Promise<void>(() => {});
    },
  );

  let uuidCounter = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );

  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  scrollToMock = vi.fn();
  HTMLElement.prototype.scrollTo =
    scrollToMock as unknown as typeof HTMLElement.prototype.scrollTo;

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
  pump = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ChatStudio auto-scroll behavior', () => {
  it('follows streamed content while the user is pinned to the bottom', async () => {
    setScrollGeometry(conversation(), {
      scrollTop: 0,
      scrollHeight: 5_000,
      clientHeight: 1_000,
    });

    await submitMessage('Stream something');
    scrollToMock.mockClear();

    await pumpEvents([
      { type: 'text-delta', payload: { text: 'First ' } },
      { type: 'text-delta', payload: { text: 'second.' } },
    ]);

    // Deltas batched into one render produce one follow scroll.
    expect(scrollToMock).toHaveBeenCalled();
    for (const call of scrollToMock.mock.calls) {
      expect(call[0]).toEqual({ top: 5_000, behavior: 'auto' });
    }
  });

  it('stops forcing the viewport down after the user scrolls up', async () => {
    await submitMessage('Long answer please');

    // User scrolls up to read earlier context.
    setScrollGeometry(conversation(), {
      scrollTop: 500,
      scrollHeight: 5_000,
      clientHeight: 1_000,
    });
    await fireScroll(conversation());
    scrollToMock.mockClear();

    // More streamed deltas must not yank the viewport back down.
    await pumpEvents([
      { type: 'text-delta', payload: { text: 'More output. ' } },
      { type: 'text-delta', payload: { text: 'Even more output.' } },
    ]);

    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('shows a jump-to-latest control while scrolled up and re-pins on click', async () => {
    await submitMessage('Long answer please');

    setScrollGeometry(conversation(), {
      scrollTop: 500,
      scrollHeight: 5_000,
      clientHeight: 1_000,
    });
    await fireScroll(conversation());

    const jump = container.querySelector<HTMLButtonElement>(
      '.chat-jump-latest',
    );
    expect(jump).not.toBeNull();

    scrollToMock.mockClear();
    await act(async () => {
      jump!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(scrollToMock).toHaveBeenCalledWith({
      top: 5_000,
      behavior: 'smooth',
    });
    expect(container.querySelector('.chat-jump-latest')).toBeNull();
  });

  it('resumes pinned following after the user scrolls back to the bottom', async () => {
    await submitMessage('Long answer please');

    // Scroll up…
    setScrollGeometry(conversation(), {
      scrollTop: 500,
      scrollHeight: 5_000,
      clientHeight: 1_000,
    });
    await fireScroll(conversation());

    // …and return near the bottom manually.
    setScrollGeometry(conversation(), {
      scrollTop: 3_950,
      scrollHeight: 5_000,
      clientHeight: 1_000,
    });
    await fireScroll(conversation());
    scrollToMock.mockClear();

    // Pinned again: subsequent streamed content must scroll the container.
    await pumpEvents([
      { type: 'text-delta', payload: { text: 'Back in view.' } },
    ]);

    expect(scrollToMock).toHaveBeenCalledTimes(1);
    expect(scrollToMock).toHaveBeenCalledWith({
      top: 5_000,
      behavior: 'auto',
    });
  });
});
