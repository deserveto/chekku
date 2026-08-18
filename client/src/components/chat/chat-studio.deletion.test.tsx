// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listAgentSkills,
  listAgentThreads,
  listThreadMessages,
  removeThread,
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
  removeThread: vi.fn(),
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
vi.mock('@/components/markdown-message', () => ({ MarkdownMessage: () => null }));
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
  removeThread,
  renameThread: vi.fn(),
}));
vi.mock('@/lib/agent-runs', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/agent-runs')>();
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

let container: HTMLDivElement;
let root: Root | null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function confirmDeletion(title: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[aria-label="Delete ${title}"]`,
  );
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());

  const confirm = Array.from(container.querySelectorAll('dialog button')).find(
    (button) => button.textContent === 'Delete',
  );
  expect(confirm).toBeDefined();
  await act(async () => {
    (confirm as HTMLButtonElement).click();
    await Promise.resolve();
  });
}

async function enterComposerText(value: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  expect(textarea).not.toBeNull();
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  expect(valueSetter).toBeDefined();

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
  listAgentSkills.mockResolvedValue([
    {
      name: 'weekly-report-analysis',
      description: 'Create a weekly product report.',
      userInvocable: true,
    },
  ]);
  listAgentThreads.mockResolvedValue(threads);
  listThreadMessages.mockResolvedValue([
    {
      id: 'stored-message',
      role: 'assistant',
      content: 'Stored response',
      createdAt: 1,
    },
  ]);
  removeThread.mockResolvedValue(undefined);
  startRun.mockResolvedValue({
    id: 'run_20260101000000_00000001',
    resourceId: 'local-user',
    agentId: 'main-agent',
    threadId: activeThreadId,
    status: 'running',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);
  cancelRun.mockResolvedValue({
    id: 'run_20260101000000_00000001',
    resourceId: 'local-user',
    agentId: 'main-agent',
    threadId: activeThreadId,
    status: 'cancelled',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  observeRunEvents.mockImplementation(
    async (
      _runId: string,
      { onEvent }: { onEvent: (event: unknown) => void },
    ) => {
      onEvent({
        sequence: 0,
        type: 'tool-call',
        payload: {
          toolCallId: 'tool-call-1',
          toolName: 'test_tool',
          args: { input: 'value' },
        },
        createdAt: '',
      });
      onEvent({
        sequence: 1,
        type: 'tool-result',
        payload: {
          toolCallId: 'tool-call-1',
          toolName: 'test_tool',
          result: { ok: true },
        },
        createdAt: '',
      });
      onEvent({ sequence: 2, type: 'finish', payload: {}, createdAt: '' });
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

  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
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

describe('ChatStudio thread deletion', () => {
  it('removes a deleted background thread from the interface without navigating', async () => {
    await confirmDeletion('Other thread');

    expect(removeThread).toHaveBeenCalledWith(
      'main-agent',
      otherThreadId,
      'local-user',
    );
    expect(
      container.querySelector('[aria-label="Delete Other thread"]'),
    ).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('replaces a deleted active thread with a fresh route and removes it locally', async () => {
    await enterComposerText('Run a tool');
    await submitComposer();
    expect(container.querySelector('.chat-tool-card')).not.toBeNull();

    await enterComposerText('/weekly');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    await confirmDeletion('Active thread');

    expect(
      container.querySelector('[aria-label="Delete Active thread"]'),
    ).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);
    const replacement = new URL(
      String(router.replace.mock.calls[0]?.[0]),
      'http://localhost',
    );
    expect(replacement.pathname).toBe('/chat');
    expect(replacement.searchParams.get('agent')).toBe('main-agent');
    expect(replacement.searchParams.get('thread')).toMatch(
      /^main-agent-local-user-/,
    );
    expect(replacement.searchParams.get('thread')).not.toBe(activeThreadId);
    expect(container.querySelector('.chat-message')).toBeNull();
    expect(container.querySelector('.chat-tool-card')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '',
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('.studio-alert-error')).toBeNull();
  });

  it('retains the thread and releases deletion state when removal fails', async () => {
    removeThread.mockRejectedValueOnce(new Error('Delete unavailable'));

    await confirmDeletion('Other thread');

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Other thread"]',
    );
    expect(deleteButton).not.toBeNull();
    expect(deleteButton?.textContent).toBe('×');
    expect(deleteButton?.disabled).toBe(false);
    expect(container.querySelector('.studio-alert-error')?.textContent).toContain(
      'Delete unavailable',
    );
    expect(container.querySelector<HTMLDialogElement>('dialog')?.open).toBe(
      false,
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
