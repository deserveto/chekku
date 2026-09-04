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
  browserImageDeps,
  browserPdfDeps,
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
  browserImageDeps: {
    decode: async () => ({ width: 10, height: 10 }),
    createCanvas: (width: number, height: number) => ({
      width,
      height,
      getContext: () => ({ drawImage: () => undefined }),
    }),
    encodeJpeg: async (canvas: { width: number }) => `PAGE${canvas.width}`,
    readBytes: async () => new Uint8Array([1, 2, 3]),
    base64Encode: () => 'QUJD',
  },
  browserPdfDeps: async () => ({
    loadPdf: async () => ({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 612 * scale,
          height: 792 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    }),
  }),
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
vi.mock('@/lib/chat-attachments-browser', () => ({
  browserImageDeps,
  browserPdfDeps,
}));
vi.mock('@/lib/memory-threads', () => ({
  listAgentThreads,
  listThreadMessages,
  removeThread: vi.fn(),
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

type SentMessage = {
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; image: string; mimeType: string }
      >;
};

let container: HTMLDivElement;
let root: Root | null;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function attachFiles(files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushEffects();
}

async function dropFiles(files: File[]): Promise<void> {
  const form = container.querySelector<HTMLFormElement>('.chat-composer');
  expect(form).not.toBeNull();
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files },
    configurable: true,
  });
  await act(async () => {
    form!.dispatchEvent(event);
    await Promise.resolve();
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

function sentMessages(): SentMessage[] {
  return startRun.mock.calls.map((call) => ({
    role: 'user',
    content: call[0].content,
  })) as SentMessage[];
}

beforeEach(async () => {
  vi.clearAllMocks();
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue([]);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue({
    id: 'run_20260101000000_00000001',
    resourceId: 'local-user',
    agentId: 'main-agent',
    threadId: activeThreadId,
    prompt: 'attachment',
    status: 'running',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  getActiveRun.mockResolvedValue(null);
  listActiveRuns.mockResolvedValue([]);
  cancelRun.mockResolvedValue(undefined);
  observeRunEvents.mockImplementation(() => new Promise<void>(() => undefined));
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

describe('ChatStudio file uploads', () => {
  it('sends text attachments as wrapped blocks inside the user message parts', async () => {
    await attachFiles([
      new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' }),
    ]);
    await enterComposerText('Summarize this');
    await submitComposer();

    const payloads = sentMessages();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.role).toBe('user');
    const parts = payloads[0]?.content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('Summarize this');
    expect(parts[0]?.text).toContain('[Attached file: data.csv');
    expect(container.querySelector('.chat-attachment-file')?.textContent).toContain(
      'data.csv',
    );
    expect(container.querySelector('.chat-upload-row')).toBeNull();
  });

  it('sends image attachments as image parts and renders a thumbnail', async () => {
    await attachFiles([
      new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
    ]);
    await submitComposer();

    const payloads = sentMessages();
    expect(payloads).toHaveLength(1);
    const parts = payloads[0]?.content as Array<
      { type: string; text?: string } | { type: 'image'; image: string; mimeType: string }
    >;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain(
      '[Attached image 1 of 1: photo.png]',
    );
    expect(parts[1]).toEqual({
      type: 'image',
      image: 'QUJD',
      mimeType: 'image/png',
      filename: 'photo.png',
    });

    const thumb = container.querySelector<HTMLImageElement>('.chat-attachment-thumb');
    expect(thumb?.getAttribute('src')).toBe('data:image/png;base64,QUJD');
    expect(thumb?.getAttribute('alt')).toBe('photo.png');

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'photo.png' }),
    );
  });

  it('renders PDF pages as sequential image parts with page markers', async () => {
    await attachFiles([
      new File([new Uint8Array([1, 2, 3])], 'report.pdf', {
        type: 'application/pdf',
      }),
    ]);
    expect(
      container.querySelector('.chat-upload-chip')?.textContent,
    ).toContain('2 pages');
    await submitComposer();

    const payloads = sentMessages();
    const parts = payloads[0]?.content as Array<
      { type: string; text?: string } | { type: 'image'; image: string; mimeType: string }
    >;
    expect(parts).toHaveLength(3);
    expect((parts[0] as { text: string }).text).toContain(
      '[Attached image 1 of 2: report.pdf — page 1 of 2]',
    );
    expect((parts[0] as { text: string }).text).toContain(
      '[Attached image 2 of 2: report.pdf — page 2 of 2]',
    );
    expect(parts[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(parts[2]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('flags unsupported files as chip errors and excludes them from the payload', async () => {
    await attachFiles([
      new File([new Uint8Array([1])], 'archive.zip', {
        type: 'application/zip',
      }),
    ]);

    const chip = container.querySelector('.chat-upload-chip.error');
    expect(chip?.textContent).toContain('archive.zip');
    expect(chip?.textContent).toContain('not supported');

    await enterComposerText('hello');
    await submitComposer();

    const payloads = sentMessages();
    const parts = payloads[0]?.content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).not.toContain('archive.zip');
  });

  it('accepts files dropped onto the composer', async () => {
    await dropFiles([
      new File(['notes'], 'notes.md', { type: 'text/markdown' }),
    ]);

    expect(container.querySelector('.chat-upload-chip')?.textContent).toContain(
      'notes.md',
    );
    expect(container.querySelector('.chat-composer')?.classList).not.toContain(
      'drag-over',
    );
  });

  it('caps pending attachments at the per-message limit', async () => {
    const files = Array.from({ length: 9 }, (_, index) =>
      new File([`f${index}`], `f${index}.txt`, { type: 'text/plain' }),
    );
    await attachFiles(files);

    expect(container.querySelectorAll('.chat-upload-chip')).toHaveLength(8);
    expect(
      container.querySelector('.studio-alert-error')?.textContent,
    ).toContain('8 attachments');
  });

  it('blocks the send while an attachment is still processing', async () => {
    const originalDecode = browserImageDeps.decode;
    let releaseDecode: (() => void) | undefined;
    browserImageDeps.decode = async () => {
      await new Promise<void>((resolve) => {
        releaseDecode = resolve;
      });
      return { width: 10, height: 10 };
    };

    await attachFiles([
      new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }),
    ]);
    expect(container.querySelector('.chat-upload-chip')?.textContent).toContain(
      'processing…',
    );

    const send = container.querySelector<HTMLButtonElement>('.chat-send-button');
    expect(send?.disabled).toBe(true);

    releaseDecode?.();
    await flushEffects();
    expect(send?.disabled).toBe(false);

    await enterComposerText('go');
    await submitComposer();
    expect(sentMessages()).toHaveLength(1);

    browserImageDeps.decode = originalDecode;
  });

  it('restores the drafted input and attachments when the send fails', async () => {
    startRun.mockRejectedValueOnce(new Error('Request failed (429)'));
    await attachFiles([
      new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
    ]);
    await enterComposerText('describe this');
    await submitComposer();

    const assistant = container.querySelector<HTMLElement>(
      '.chat-message.assistant',
    );
    expect(assistant?.classList).toContain('error');
    expect(assistant?.textContent).toContain('Could not complete request');

    // The prepared attachment and typed input come back for a retry.
    expect(container.querySelector('.chat-upload-chip')?.textContent).toContain(
      'photo.png',
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe('describe this');
  });

  it('surfaces a server-reported tripwire as an assistant error', async () => {
    observeRunEvents.mockImplementationOnce(async (_runId, options) => {
      options.onEvent({
        sequence: 0,
        type: 'error',
        payload: {
          error:
            'Request stopped by a safety limit. TokenLimiterProcessor: No messages fit within the remaining token budget.',
        },
        createdAt: '',
      });
    });

    await enterComposerText('hello');
    await submitComposer();

    const assistant = container.querySelector<HTMLElement>(
      '.chat-message.assistant',
    );
    expect(assistant?.classList).toContain('error');
    expect(assistant?.textContent).toContain('Request stopped by a safety limit.');
    expect(assistant?.textContent).toContain(
      'No messages fit within the remaining token budget',
    );
    expect(assistant?.textContent).not.toContain(
      'Generation ended before a final response was produced',
    );
  });
});
