// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ResizableSidebar } from './resizable-sidebar';
import { SIDEBAR_DEFAULT_WIDTH } from '@/lib/sidebar-state';

// Deterministic requestAnimationFrame queue: tests flush frames manually so
// the two-frame hydration sequence is observable.
let frameQueue: Array<() => void> = [];
function flushFrame(): void {
  const next = frameQueue.shift();
  if (next) next();
}

beforeEach(() => {
  frameQueue = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    (callback: (time: number) => void) => {
      frameQueue.push(() => callback(0));
      return frameQueue.length;
    },
  );
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

let root: Root | null = null;
function render(ui: ReactElement): HTMLElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = '';
  root = null;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function aside(container: HTMLElement): HTMLElement {
  const element = container.querySelector('aside');
  if (!element) throw new Error('sidebar aside not rendered');
  return element;
}

describe('ResizableSidebar two-frame hydration', () => {
  it('paints persisted width/collapsed before ready and enables transitions after the second frame', () => {
    window.localStorage.setItem(
      'test-sidebar',
      JSON.stringify({ width: 320, collapsed: true }),
    );

    const container = render(
      <ResizableSidebar
        id="studio-navigation"
        className="studio-nav"
        storageKey="test-sidebar"
        label="Studio sidebar"
      >
        {() => null}
      </ResizableSidebar>,
    );

    const element = aside(container);
    // Before any frame flush: defaults, no persisted state, no ready.
    expect(element.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
    expect(element.className).not.toContain('is-ready');

    act(() => {
      flushFrame();
    });
    // Frame 1: persisted width applied, still no `is-ready` —
    // transitions stay suppressed.
    expect(element.style.width).toBe('72px');
    expect(element.className).toContain('is-collapsed');
    expect(element.className).not.toContain('is-ready');

    act(() => {
      flushFrame();
    });
    // Frame 2: transitions enabled with no further width change.
    expect(element.className).toContain('is-ready');
    expect(element.style.width).toBe('72px');
  });

  it('persists expanded width and collapse state on later toggles', () => {
    window.localStorage.setItem(
      'test-sidebar',
      JSON.stringify({ width: 320, collapsed: false }),
    );

    let toggle: (() => void) | undefined;
    const container = render(
      <ResizableSidebar
        id="studio-navigation"
        className="studio-nav"
        storageKey="test-sidebar"
        label="Studio sidebar"
      >
        {(_collapsed, toggleCollapsed) => {
          toggle = toggleCollapsed;
          return null;
        }}
      </ResizableSidebar>,
    );
    act(() => {
      flushFrame();
      flushFrame();
    });

    act(() => {
      toggle?.();
    });
    expect(aside(container).className).toContain('is-collapsed');

    const stored = JSON.parse(
      window.localStorage.getItem('test-sidebar') ?? '{}',
    ) as { width?: number; collapsed?: boolean };
    expect(stored).toEqual({ width: 320, collapsed: true });
  });
});
