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
  // Render text so DOM ordering assertions can read the streamed content.
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

type StreamEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

let container: HTMLDivElement;
let root: Root | null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

function eventsOf(events: StreamEvent[]) {
  return async (
    _runId: string,
    { onEvent }: { onEvent: (event: unknown) => void },
  ) => {
    let seq = 0;
    for (const item of events) {
      onEvent({
        sequence: seq++,
        type: item.type,
        payload: item.payload ?? {},
        createdAt: new Date().toISOString(),
      });
    }
  };
}

/** Ordered sibling signatures inside the last assistant article. */
function assistantTimeline(): string[] {
  const articles = container.querySelectorAll('article.chat-message.assistant');
  const article = articles[articles.length - 1];
  expect(article).toBeDefined();

  const blocks = Array.from(
    article.querySelectorAll(
      ':scope > .chat-tool-timeline, :scope > .chat-message-content',
    ),
  );

  return blocks.map((block) => {
    if (block.classList.contains('chat-tool-timeline')) {
      const names = Array.from(
        block.querySelectorAll('.chat-tool-card strong'),
      ).map((node) => node.textContent);
      return `tools:[${names.join('|')}]`;
    }
    return `text:${block.textContent}`;
  });
}

function toolCards(): Element[] {
  return Array.from(container.querySelectorAll('.chat-tool-card'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue([]);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue({
    id: 'run_timeline_test',
    resourceId: 'local-user',
    agentId: 'main-agent',
    threadId: activeThreadId,
    status: 'running',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);
  observeRunEvents.mockImplementation(eventsOf([{ type: 'complete' }]));

  let uuidCounter = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
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

describe('ChatStudio chronological tool timeline', () => {
  it('renders a tool call above text that streams after it (case 1)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'call-1',
            toolName: 'browser_goto',
            args: { url: 'https://example.com' },
          },
        },
        {
          type: 'tool-result',
          payload: { toolCallId: 'call-1', result: { ok: true } },
        },
        { type: 'text-delta', payload: { text: 'I opened the page.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Open the site');

    expect(assistantTimeline()).toEqual([
      'tools:[browser goto]',
      'text:I opened the page.',
    ]);
  });

  it('keeps text streamed before a tool above it and text after below (case 2)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        { type: 'text-delta', payload: { text: 'Inspecting the form.' } },
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'call-1',
            toolName: 'browser_snapshot',
            args: {},
          },
        },
        {
          type: 'tool-result',
          payload: { toolCallId: 'call-1', result: { fields: 4 } },
        },
        { type: 'text-delta', payload: { text: 'The form has four fields.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Inspect the form');

    expect(assistantTimeline()).toEqual([
      'text:Inspecting the form.',
      'tools:[browser snapshot]',
      'text:The form has four fields.',
    ]);
  });

  it('places two interleaved tools at their execution points (case 3)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        {
          type: 'tool-call',
          payload: { toolCallId: 'a', toolName: 'browser_goto', args: {} },
        },
        { type: 'tool-result', payload: { toolCallId: 'a', result: {} } },
        { type: 'text-delta', payload: { text: 'Middle.' } },
        {
          type: 'tool-call',
          payload: { toolCallId: 'b', toolName: 'browser_click', args: {} },
        },
        { type: 'tool-result', payload: { toolCallId: 'b', result: {} } },
        { type: 'text-delta', payload: { text: 'Done.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Walk the flow');

    expect(assistantTimeline()).toEqual([
      'tools:[browser goto]',
      'text:Middle.',
      'tools:[browser click]',
      'text:Done.',
    ]);
  });

  it('updates the same card from running to complete without duplicates (case 4)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        {
          type: 'tool-call',
          payload: {
            toolCallId: 'call-1',
            toolName: 'browser_goto',
            args: { url: 'https://example.com' },
          },
        },
        {
          type: 'tool-result',
          payload: { toolCallId: 'call-1', result: { ok: true } },
        },
        { type: 'text-delta', payload: { text: 'Ready.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Open it');

    expect(toolCards()).toHaveLength(1);
    expect(toolCards()[0]?.className).toBe('chat-tool-card complete');
    // args stay visible after the result arrives
    const pres = toolCards()[0]?.querySelectorAll('pre');
    expect(pres?.[0]?.textContent).toContain('example.com');
    expect(pres?.[1]?.textContent).toContain('ok');
  });

  it('updates the same card from running to error (case 5)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        {
          type: 'tool-call',
          payload: { toolCallId: 'call-1', toolName: 'browser_click' },
        },
        {
          type: 'tool-error',
          payload: { toolCallId: 'call-1', error: 'selector not found' },
        },
        { type: 'text-delta', payload: { text: 'I could not click.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Click it');

    expect(toolCards()).toHaveLength(1);
    expect(toolCards()[0]?.className).toBe('chat-tool-card error');
    expect(assistantTimeline()).toEqual([
      'tools:[browser click]',
      'text:I could not click.',
    ]);
  });

  it('merges consecutive text deltas into one text block (case 6)', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        { type: 'text-delta', payload: { text: 'Found ' } },
        { type: 'text-delta', payload: { text: 'the signup ' } },
        { type: 'text-delta', payload: { text: 'form.' } },
        {
          type: 'tool-call',
          payload: { toolCallId: 'a', toolName: 'browser_snapshot' },
        },
        { type: 'tool-result', payload: { toolCallId: 'a', result: {} } },
        { type: 'text-delta', payload: { text: 'It has ' } },
        { type: 'text-delta', payload: { text: 'four fields.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Look around');

    expect(assistantTimeline()).toEqual([
      'text:Found the signup form.',
      'tools:[browser snapshot]',
      'text:It has four fields.',
    ]);
  });

  it('groups back-to-back tool calls into one timeline cluster', async () => {
    observeRunEvents.mockImplementation(
      eventsOf([
        {
          type: 'tool-call',
          payload: { toolCallId: 'a', toolName: 'browser_goto' },
        },
        { type: 'tool-result', payload: { toolCallId: 'a', result: {} } },
        {
          type: 'tool-call',
          payload: { toolCallId: 'b', toolName: 'browser_snapshot' },
        },
        { type: 'tool-result', payload: { toolCallId: 'b', result: {} } },
        { type: 'text-delta', payload: { text: 'Both done.' } },
        { type: 'complete', payload: {} },
      ]),
    );

    await submitMessage('Goto and snapshot');

    expect(assistantTimeline()).toEqual([
      'tools:[browser goto|browser snapshot]',
      'text:Both done.',
    ]);
    expect(toolCards()).toHaveLength(2);
  });

  it('renders restored Memory messages through the text-only fallback', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    listThreadMessages.mockResolvedValue([
      {
        id: 'stored-assistant',
        role: 'assistant',
        content: 'Stored response without parts',
        createdAt: 2,
      },
    ]);

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

    expect(container.querySelectorAll('.chat-tool-card')).toHaveLength(0);
    expect(
      container.querySelector('.chat-message-content')?.textContent,
    ).toContain('Stored response without parts');
  });

  it('re-renders the tool timeline in order when re-entering a session', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Shape produced by listThreadMessages after Mastra Memory V2 parts are
    // rebuilt through restoreAssistantParts.
    listThreadMessages.mockResolvedValue([
      {
        id: 'stored-user',
        role: 'user',
        content: 'Check the signup flow.',
        createdAt: 1,
      },
      {
        id: 'stored-assistant',
        role: 'assistant',
        content: 'The page is open.\nAll set.',
        createdAt: 2,
        parts: [
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
          {
            type: 'text',
            id: 'stored-assistant-x3',
            content: 'All set.',
          },
        ],
      },
    ]);

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

    expect(assistantTimeline()).toEqual([
      'tools:[browser goto]',
      'text:The page is open.',
      'tools:[browser snapshot]',
      'text:All set.',
    ]);
    expect(toolCards()).toHaveLength(2);
    expect(toolCards()[0]?.className).toBe('chat-tool-card complete');
    expect(toolCards()[1]?.className).toBe('chat-tool-card complete');
    expect(container.querySelector('.chat-typing')).toBeNull();
  });

  it('does not show a typing indicator for completed tool-only turn restored from Memory', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    listThreadMessages.mockResolvedValue([
      {
        id: 'stored-assistant',
        role: 'assistant',
        content: '',
        createdAt: 2,
        parts: [
          {
            type: 'tool',
            id: 'stored-assistant-t0',
            toolCallId: 'call-1',
            toolName: 'browser_click',
            status: 'complete',
            result: { clicked: true },
          },
        ],
      },
    ]);

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

    expect(toolCards()).toHaveLength(1);
    expect(container.querySelector('.chat-typing')).toBeNull();
  });
});
