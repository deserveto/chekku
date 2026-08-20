// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import ApproveButton from './ApproveButton';
import GenerationPending from './GenerationPending';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;
const fetchMock = vi.fn<typeof globalThis.fetch>();

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

function errorResponse(): Response {
  return {
    ok: false,
    status: 409,
    json: async () => ({ error: { message: 'Invalid status transition.' } }),
  } as unknown as Response;
}

function renderApprove(nextStatus: 'CANONICAL_APPROVED' | 'APPROVED' = 'CANONICAL_APPROVED') {
  act(() => {
    root!.render(
      <ApproveButton
        postId="smp_20260714120000_deadbeef"
        nextStatus={nextStatus}
        label="Approve Canonical"
      />,
    );
  });
}

function renderPending() {
  act(() => {
    root!.render(
      <GenerationPending
        label="Generating image…"
        timeoutMessage="Image generation is taking longer than expected."
      />,
    );
  });
}

function button(): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ApproveButton', () => {
  it('renders the stage label enabled', () => {
    renderApprove();
    expect(button().textContent).toBe('Approve Canonical');
    expect(button().disabled).toBe(false);
  });

  it('PATCHes the stage transition and shows the working label while pending', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderApprove();

    await act(async () => {
      button().click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage/social-posts/smp_20260714120000_deadbeef',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'CANONICAL_APPROVED' }),
      }),
    );
    expect(button().textContent).toBe('Generating caption…');
    expect(button().disabled).toBe(true);
  });

  it('surfaces the PATCH error and re-enables the button', async () => {
    fetchMock.mockResolvedValue(errorResponse());
    renderApprove();

    await act(async () => {
      button().click();
    });

    expect(button().textContent).toBe('Approve Canonical');
    expect(button().disabled).toBe(false);
    expect(container.textContent).toContain('Invalid status transition.');
  });

  it('polls refresh after a successful PATCH, then stops with recovery guidance once the budget runs out', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderApprove();

    await act(async () => {
      button().click();
    });
    expect(mocks.refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    // Budget exhausted: polling stopped, timeout guidance shown, button re-enabled.
    expect(container.textContent).toContain('taking longer than expected');
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Approve Canonical');

    const callsAtStop = mocks.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.refresh.mock.calls.length).toBe(callsAtStop);
  });

  it('labels the image stage while pending', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderApprove('APPROVED');

    await act(async () => {
      button().click();
    });

    expect(button().textContent).toBe('Generating image…');
  });
});

describe('GenerationPending', () => {
  it('renders the pending label as a live status', () => {
    renderPending();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Generating image…');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('polls refresh inside the budget, then swaps to the timeout alert and stops', async () => {
    renderPending();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Image generation is taking longer than expected.');
    expect(container.querySelector('[role="status"]')).toBeNull();

    const callsAtStop = mocks.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.refresh.mock.calls.length).toBe(callsAtStop);
  });
});
