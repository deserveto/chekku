// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  knowledgeUpload,
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
  knowledgeUpload: vi.fn(),
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
vi.mock('@/lib/knowledge', async () => {
  const actual = await vi.importActual<object>('@/lib/knowledge');
  return {
    ...actual,
    uploadKnowledgeDocument: knowledgeUpload,
  };
});
vi.mock('@/lib/memory-threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/memory-threads')>();
  return {
    ...actual,
    listAgentThreads,
    listThreadMessages,
    removeThread: vi.fn(),
  };
});
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
  knowledgeUpload.mockResolvedValue({ ok: false, message: 'Knowledge upload unavailable in test.' });
  listAgentSkills.mockResolvedValue([]);
  listAgentThreads.mockResolvedValue([]);
  listThreadMessages.mockResolvedValue([]);
  startRun.mockResolvedValue({
    id: 'run_20260101000000_00000001',
    resourceId: 'local-user',
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

describe('ChatStudio knowledge reconciliation', () => {
  const documentView = (overrides: Partial<{ id: string; status: string; error: string | null }> = {}) => ({
    id: 'kbd_20260101000000_deadbeef',
    status: 'processing',
    error: null,
    ...overrides,
  });

  type ListResponse = { status: number; documents: Array<{ id: string; status: string; error?: string | null }> };
  let fetchMock: ReturnType<typeof vi.fn>;
  function stubListEndpoint(respond: () => ListResponse): void {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(respond()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  }

  // Installs fake timers BEFORE the submit so the component's polling
  // interval is created against the fake scheduler (an interval created on
  // the real clock would never advance under fake timers).
  async function attachAndSubmitUnderFakeTimers(): Promise<void> {
    knowledgeUpload.mockResolvedValue({
      ok: true,
      document: { id: 'kbd_20260101000000_deadbeef', status: 'processing' },
    });
    await attachFiles([
      new File(['knowledge text'], 'notes.txt', { type: 'text/plain' }),
    ]);
    vi.useFakeTimers();
    const form = container.querySelector<HTMLFormElement>('.chat-composer');
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const chip = container.querySelector('.chat-knowledge-status');
    // The chip exists at acceptance in a bounded state; an immediate
    // reconciliation tick may already have observed a terminal status.
    expect(chip?.getAttribute('data-knowledge-state')).toEqual(
      expect.stringMatching(/^(indexing|added|failed)$/),
    );
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the chip indexing after upload acceptance and flips to added when the document is ready', async () => {
    stubListEndpoint(() => ({
      status: 200,
      documents: [documentView()],
    }));
    await attachAndSubmitUnderFakeTimers();

    // The immediate reconciliation tick polled the list endpoint before the
    // first interval elapse.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // Document still processing: chip keeps indexing and the interval keeps
    // polling after the immediate tick.
    expect(container.querySelector('.chat-knowledge-status')?.getAttribute('aria-label')).toContain(
      'Indexing',
    );
    const callsAfterFirstTick = fetchMock.mock.calls.length;
    expect(callsAfterFirstTick).toBeGreaterThanOrEqual(2);

    stubListEndpoint(() => ({
      status: 200,
      documents: [documentView({ status: 'ready' })],
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.querySelector('.chat-knowledge-status')?.getAttribute('aria-label')).toContain(
      'Added to Knowledge',
    );

    // Every candidate settled: polling stops.
    const callsAfterSettled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterSettled);
  });

  it('flips to added immediately when the upload acceptance snapshot is already ready', async () => {
    // Small files can finish indexing before the upload POST even returns;
    // the chip must trust that snapshot instead of spinning until the first
    // list poll observes it.
    stubListEndpoint(() => ({
      status: 200,
      documents: [],
    }));
    knowledgeUpload.mockResolvedValue({
      ok: true,
      document: { id: 'kbd_20260101000000_deadbeef', status: 'ready' },
    });
    await attachFiles([
      new File(['instant text'], 'quick.txt', { type: 'text/plain' }),
    ]);
    vi.useFakeTimers();
    const form = container.querySelector<HTMLFormElement>('.chat-composer');
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    const chip = container.querySelector('.chat-knowledge-status');
    expect(chip?.getAttribute('data-knowledge-state')).toBe('added');
    expect(chip?.getAttribute('aria-label')).toContain('Added to Knowledge');
    // Already settled at acceptance: no list polling ever starts.
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('marks the chip failed with the server reason while preserving the documentId', async () => {
    stubListEndpoint(() => ({
      status: 200,
      documents: [
        documentView({ status: 'failed', error: 'The knowledge index is currently unreachable. Check the Qdrant service and retry.' }),
      ],
    }));
    await attachAndSubmitUnderFakeTimers();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const chip = container.querySelector('.chat-knowledge-status');
    expect(chip?.getAttribute('aria-label')).toContain('unreachable');
    expect(chip?.getAttribute('data-knowledge-state')).toBe('failed');

    // The failed entry no longer polls.
    const callsAfterSettled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterSettled);
  });

  it('expires polling at the budget and keeps the chip indexing while polling stops', async () => {
    stubListEndpoint(() => ({
      status: 200,
      documents: [documentView()],
    }));
    await attachAndSubmitUnderFakeTimers();

    // Polling runs while the budget lasts...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 60 * 1_000);
    });
    // ...and stops terminal-expired: the chip flips to the stalled marker
    // (the record may genuinely still be indexing server-side) with the
    // guidance in its accessible label, while automatic polling ceases.
    const chip = container.querySelector('.chat-knowledge-status');
    expect(chip?.getAttribute('data-knowledge-state')).toBe('stalled');
    expect(chip?.getAttribute('aria-label')).toContain('Still indexing');
    const callsAtExpiry = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAtExpiry);
  });

  it('grants a fresh polling window to a new upload after the previous one settles', async () => {
    // End the first run via its event stream so the composer re-arms for
    // the SECOND send this test performs.
    observeRunEvents.mockImplementationOnce(async (_runId: string, options: { onEvent: (event: { sequence: number; type: string; payload: { error: string }; createdAt: string }) => void }) => {
      options.onEvent({
        sequence: 0,
        type: 'error',
        payload: { error: 'first run ended' },
        createdAt: '',
      });
    });
    // First upload settles ready: its window is consumed and the candidate
    // set becomes empty, which resets the polling budget.
    stubListEndpoint(() => ({
      status: 200,
      documents: [documentView({ status: 'ready' })],
    }));
    await attachAndSubmitUnderFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(
      container.querySelector('.chat-knowledge-status')?.getAttribute('aria-label'),
    ).toContain('Added to Knowledge');

    // A NEW upload gets a fresh window: polling runs again for it. The
    // second attach/submit stays under fake timers (flushed through the
    // fake clock) so the new interval lands on the fake scheduler.
    knowledgeUpload.mockResolvedValueOnce({
      ok: true,
      document: { id: 'kbd_20260101000000_cafe0001', status: 'processing' },
    });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput, 'files', {
      value: [new File(['more text'], 'more.txt', { type: 'text/plain' })],
      configurable: true,
    });
    await act(async () => {
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const form = container.querySelector<HTMLFormElement>('.chat-composer');
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const chips = [...container.querySelectorAll('.chat-knowledge-status')];
    expect(chips.length).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(
      chips.some((element) => element.getAttribute('aria-label')?.includes('Added to Knowledge')),
    ).toBe(true);
  });

  it('stops polling on unmount', async () => {
    stubListEndpoint(() => ({
      status: 200,
      documents: [documentView()],
    }));
    await attachAndSubmitUnderFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    act(() => root?.unmount());
    root = null;
    const callsAtUnmount = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount);
  });
});

describe('ChatStudio pdf cards and viewer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubListEndpoint(
    documents: Array<{ id: string; status: string; error?: string | null }>,
  ): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ documents }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  async function attachPdfAndSend(
    uploadImplementation?: () => Promise<unknown>,
  ): Promise<void> {
    if (uploadImplementation) {
      knowledgeUpload.mockImplementationOnce(uploadImplementation);
    } else {
      knowledgeUpload.mockResolvedValueOnce({
        ok: true,
        document: { id: 'kbd_20260101000000_deadbeef', status: 'processing' },
      });
    }
    await attachFiles([
      new File([new Uint8Array([1, 2, 3])], 'report.pdf', {
        type: 'application/pdf',
      }),
    ]);
    await submitComposer();
  }

  it('opens the original-PDF viewer while the upload is still indexing', async () => {
    stubListEndpoint([
      { id: 'kbd_20260101000000_deadbeef', status: 'processing' },
    ]);
    await attachPdfAndSend();

    const card = container.querySelector<HTMLButtonElement>('.chat-pdf-card');
    expect(card).not.toBeNull();
    expect(card!.disabled).toBe(false);
    await act(async () => {
      card!.click();
      await Promise.resolve();
    });

    const frame = container.querySelector<HTMLIFrameElement>('.chat-pdf-frame');
    expect(frame).not.toBeNull();
    // The original-bytes route is available the moment the upload POST
    // succeeded — indexing state must not block the viewer.
    expect(frame!.getAttribute('src')).toBe(
      '/api/storage/knowledge/documents/kbd_20260101000000_deadbeef/original',
    );
  });

  it('still opens the original-PDF viewer after indexing fails', async () => {
    stubListEndpoint([
      {
        id: 'kbd_20260101000000_deadbeef',
        status: 'failed',
        error: 'The knowledge index is currently unreachable. Check the Qdrant service and retry.',
      },
    ]);
    await attachPdfAndSend();

    const card = container.querySelector<HTMLButtonElement>('.chat-pdf-card');
    expect(card!.disabled).toBe(false);
    await act(async () => {
      card!.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLIFrameElement>('.chat-pdf-frame')?.getAttribute('src'),
    ).toBe('/api/storage/knowledge/documents/kbd_20260101000000_deadbeef/original');
  });

  it('renders a disabled card before the upload resolves', async () => {
    await attachPdfAndSend(() => new Promise<never>(() => undefined));

    const card = container.querySelector<HTMLButtonElement>('.chat-pdf-card');
    expect(card).not.toBeNull();
    expect(card!.disabled).toBe(true);
    expect(card!.getAttribute('title')).toContain('opens once the upload finishes');
  });

  it('opens the grouped-page viewer for a restored multi-page pdf and closes on Escape', async () => {
    listThreadMessages.mockResolvedValue([
      {
        id: 'msg-pdf-restore',
        role: 'user',
        content: 'the report',
        createdAt: 1,
        attachments: [
          {
            mimeType: 'application/pdf',
            filename: 'restored.pdf',
            dataUrl: 'data:image/jpeg;base64,UDDE=',
            pageCount: 2,
            pages: ['data:image/jpeg;base64,UDDE=', 'data:image/jpeg;base64,UDDF='],
          },
        ],
      },
    ]);
    // Re-render the same harness with the restored thread loaded.
    await act(async () => {
      root?.unmount();
      document.body.innerHTML = '';
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(
        <ChatStudio
          resourceId="local-user"
          initialAgentId="main-agent"
          initialThreadId={activeThreadId}
        />,
      );
    });
    await flushEffects();

    const card = container.querySelector<HTMLButtonElement>('.chat-pdf-card');
    expect(card).not.toBeNull();
    expect(card!.disabled).toBe(false);
    await act(async () => {
      card!.click();
      await Promise.resolve();
    });

    // No documentId survives restore: the grouped-page viewer opens.
    expect(container.querySelector('.chat-pdf-frame')).toBeNull();
    expect(container.querySelectorAll('.chat-pdf-page img')).toHaveLength(2);
    expect(container.textContent).toContain('restored.pdf');

    // Escape closes through the native cancel path.
    const dialog = container.querySelector('dialog.chat-pdf-viewer');
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog!.dispatchEvent(
        new Event('cancel', { bubbles: false, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('dialog.chat-pdf-viewer')).toBeNull();
  });
});
