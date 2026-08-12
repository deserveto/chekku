// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listAgentSkills,
  listAgentThreads,
  listThreadMessages,
  removeThread,
  router,
} = vi.hoisted(() => ({
  listAgentSkills: vi.fn(),
  listAgentThreads: vi.fn(),
  listThreadMessages: vi.fn(),
  removeThread: vi.fn(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/agents/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@/components/chat/command-menu', () => ({ CommandMenu: () => null }));
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
vi.mock('@/lib/mastra-client', () => ({
  mastraClient: { getAgent: vi.fn(() => ({})) },
}));
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

beforeEach(async () => {
  vi.clearAllMocks();
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue(threads);
  listThreadMessages.mockResolvedValue([]);
  removeThread.mockResolvedValue(undefined);
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    '00000000-0000-4000-8000-000000000000',
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
    await confirmDeletion('Active thread');

    expect(
      container.querySelector('[aria-label="Delete Active thread"]'),
    ).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith(
      '/chat?thread=main-agent-local-user-00000000-0000-4000-8000-000000000000&agent=main-agent',
    );
  });
});
