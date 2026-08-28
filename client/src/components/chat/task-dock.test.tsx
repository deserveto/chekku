// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDock } from './task-dock';
import type { TaskItem } from '@/lib/task-list';

let container: HTMLDivElement;
let root: Root | null;

/**
 * jsdom never evaluates media queries (matchMedia().matches is always
 * false), so drawer/desktop mode is decided by this stub instead of the
 * viewport width.
 */
function stubDrawerMode(drawer: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: drawer,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

/**
 * Like stubDrawerMode, but captures `change` listeners so a test can
 * simulate the viewport crossing the breakpoint while the dock lives.
 */
function stubDrawerModeWithChange(initial: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mql = {
    matches: initial,
    addEventListener: vi.fn(
      (_type: string, listener: (event: { matches: boolean }) => void) => {
        listeners.add(listener);
      },
    ),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue(mql),
  );
  return {
    fireChange(matches: boolean) {
      mql.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
}

beforeEach(() => {
  stubDrawerMode(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const TASKS: TaskItem[] = [
  {
    id: 'task_1',
    content: 'Identify authentication flows',
    activeForm: 'Identifying authentication flows',
    status: 'completed',
  },
  {
    id: 'task_2',
    content: 'Test login',
    activeForm: 'Testing login flow',
    status: 'in_progress',
  },
  {
    id: 'task_3',
    content: 'Test password reset',
    activeForm: 'Testing password reset',
    status: 'pending',
  },
];

function render(props: Parameters<typeof TaskDock>[0]): void {
  act(() => {
    root!.render(<TaskDock {...props} />);
  });
}

describe('TaskDock expanded', () => {
  it('renders every task with its status mark and progress count', () => {
    render({ tasks: TASKS, open: true, onToggle: vi.fn() });

    const items = container.querySelectorAll('.chat-task-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.className).toContain('completed');
    expect(items[1]!.className).toContain('in_progress');
    expect(items[2]!.className).toContain('pending');

    expect(container.textContent).toContain('1/3');
    expect(container.textContent).toContain('Identify authentication flows');
    // Status is not color-only: each row carries a screen-reader label.
    expect(container.textContent).toContain('in progress');
  });

  it('shows activeForm only for the in-progress task', () => {
    render({ tasks: TASKS, open: true, onToggle: vi.fn() });

    expect(container.textContent).toContain('Testing login flow');
    expect(container.textContent).not.toContain(
      'Identifying authentication flows…',
    );
    expect(container.textContent).not.toContain('Testing password reset…');
  });

  it('keeps all-completed lists visible with a full count', () => {
    const done = TASKS.map((task) => ({ ...task, status: 'completed' as const }));
    render({ tasks: done, open: true, onToggle: vi.fn() });

    expect(container.querySelector('.chat-task-dock')).not.toBeNull();
    expect(container.textContent).toContain('3/3');
  });

  it('toggles collapsed from the collapse button', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse task panel"]',
    );
    expect(collapse).not.toBeNull();
    act(() => collapse!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape only when it is the topmost overlay', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    // A higher overlay (e.g. the delete ConfirmationDialog) is open on
    // top: Escape belongs to it, not the dock.
    const topmost = document.createElement('dialog');
    topmost.open = true;
    document.body.appendChild(topmost);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onToggle).not.toHaveBeenCalled();

    topmost.remove();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('closes from a backdrop click in drawer mode', () => {
    stubDrawerMode(true);
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const dialog = container.querySelector<HTMLDialogElement>(
      'dialog.chat-task-dock-dialog',
    );
    expect(dialog).not.toBeNull();
    // A click reaching the dialog element itself is outside the panel.
    act(() => {
      dialog!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('presents drawer mode as a native dialog and restores focus on close', () => {
    stubDrawerMode(true);
    const onToggle = vi.fn();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render({ tasks: TASKS, open: true, onToggle });

    const dialog = container.querySelector<HTMLDialogElement>(
      'dialog.chat-task-dock-dialog',
    );
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('open')).not.toBeNull();
    // Focus moved into the drawer.
    expect(document.activeElement?.closest('dialog')).toBe(dialog);

    render({ tasks: TASKS, open: false, onToggle });
    expect(dialog!.open).toBe(false);
    // Focus restored to the element that opened the drawer.
    expect(document.activeElement).toBe(opener);
  });

  it('collapses from the native dialog cancel event (drawer Escape)', () => {
    stubDrawerMode(true);
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const dialog = container.querySelector<HTMLDialogElement>(
      'dialog.chat-task-dock-dialog',
    )!;
    const cancelEvent = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancelEvent);
    });
    // The collapse is owned by Chekku state, not the browser's own
    // dialog close: preventDefault keeps the two from racing.
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('switches surfaces when the viewport crosses the breakpoint while open', () => {
    const media = stubDrawerModeWithChange(false);
    const onToggle = vi.fn();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    render({ tasks: TASKS, open: true, onToggle });
    // Desktop column: aside, no dialog.
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('aside.chat-task-dock')).not.toBeNull();

    // Shrink below the breakpoint while open: the dialog takes over.
    act(() => media.fireChange(true));
    const dialog = container.querySelector<HTMLDialogElement>(
      'dialog.chat-task-dock-dialog',
    );
    expect(dialog).not.toBeNull();
    expect(dialog!.hasAttribute('open')).toBe(true);

    // Grow back past the breakpoint while open: the dialog surface is
    // gone, the column renders again, and focus returns to the saved
    // invoker instead of falling to <body>.
    act(() => media.fireChange(false));
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('aside.chat-task-dock')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('renders the relative updated time when provided', () => {
    render({
      tasks: TASKS,
      open: true,
      onToggle: vi.fn(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
    });

    const line = container.querySelector('.chat-task-dock-updated');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('updated');
    expect(line!.textContent).toMatch(/30s ago/);
  });

  it('omits the updated line when no timestamp exists (Memory restore)', () => {
    render({ tasks: TASKS, open: true, onToggle: vi.fn() });
    expect(container.querySelector('.chat-task-dock-updated')).toBeNull();
  });

  it('scrolls the in-progress task into the visible band', () => {
    render({ tasks: TASKS, open: true, onToggle: vi.fn() });

    const list = container.querySelector<HTMLOListElement>(
      '.chat-task-dock-list',
    );
    expect(list).not.toBeNull();
    // jsdom lays out offsetTop=0 so no scroll movement is expected; the
    // effect must still run without error and leave scrollTop at 0.
    expect(list!.scrollTop).toBe(0);
    expect(
      list!.querySelector('.chat-task-item.in_progress'),
    ).not.toBeNull();
  });

  it('declares the scroll list as its own offset parent', () => {
    // jsdom does not load stylesheets, so assert the rule exists in the
    // stylesheet source instead.
    const css = readFileSync(
      resolve(__dirname, '../../app/studio.css'),
      'utf8',
    );
    const listRule = css.match(/\.chat-task-dock-list\s*\{[^}]*\}/)?.[0];
    expect(listRule).toBeDefined();
    // offsetTop math needs the list positioned; otherwise rows measure
    // against body (desktop) or the fixed aside (drawer) and the
    // auto-scroll band is biased by the header height.
    expect(listRule).toMatch(/position:\s*relative/);
  });

  it('never lays out the closed drawer dialog', () => {
    // jsdom applies no CSS, so a collapsed drawer that paints an opaque
    // panel over the conversation is invisible to every DOM test. Assert
    // the source: an author `display` on the base dialog rule overrides
    // the UA's `dialog:not([open]) { display: none }` regardless of
    // specificity, so display may live ONLY under [open].
    const css = readFileSync(
      resolve(__dirname, '../../app/studio.css'),
      'utf8',
    );
    const baseRule =
      css.match(/dialog\.chat-task-dock-dialog\s*\{[^}]*\}/)?.[0];
    expect(baseRule).toBeDefined();
    expect(baseRule).not.toMatch(/display:/);

    const closedRule = css.match(
      /dialog\.chat-task-dock-dialog:not\(\[open\]\)\s*\{[^}]*\}/,
    )?.[0];
    expect(closedRule).toMatch(/display:\s*none/);

    const openRule = css.match(
      /dialog\.chat-task-dock-dialog\[open\]\s*\{[^}]*\}/,
    )?.[0];
    expect(openRule).toMatch(/display:\s*flex/);
  });

  it('drops the mobile drawer below the taller mobile topbar', () => {
    // The 760px override must outrank the base dialog rule's 69px top
    // (equal specificity, later in the stylesheet) — assert the override
    // targets the dialog element itself.
    const css = readFileSync(
      resolve(__dirname, '../../app/studio.css'),
      'utf8',
    );
    const mobileBlock = css.match(/@media \(max-width: 760px\)\s*\{[\s\S]*$/);
    expect(mobileBlock).toBeDefined();
    expect(mobileBlock![0]).toMatch(
      /dialog\.chat-task-dock-dialog[\s\S]{0,200}?top:\s*137px/,
    );
  });

  it('pauses auto-scroll while the user has scrolled away', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const list = container.querySelector<HTMLOListElement>(
      '.chat-task-dock-list',
    )!;
    // The user scrolls up to read earlier rows.
    act(() => {
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 40,
      });
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    // A new snapshot arrives; the in-progress row may move but the dock
    // must not yank the user's scroll position.
    const scrolled = vi.spyOn(list, 'scrollTop', 'set');
    render({ tasks: [...TASKS], open: true, onToggle });
    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();
  });

  it('does not pause auto-scroll on its own programmatic scroll event', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const list = container.querySelector<HTMLOListElement>(
      '.chat-task-dock-list',
    )!;
    // Lay the active row (task_2) below the fold: rows 250..280 in a
    // 200px viewport.
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    const active = list.querySelector<HTMLElement>(
      '.chat-task-item.in_progress',
    )!;
    Object.defineProperty(active, 'offsetTop', { configurable: true, value: 250 });
    Object.defineProperty(active, 'offsetHeight', { configurable: true, value: 30 });

    // Re-run the snapshot effect with the geometry in place.
    render({ tasks: [...TASKS], open: true, onToggle });
    expect(list.scrollTop).toBe(80); // 280 - 200

    // The browser fires a (async) scroll event for that programmatic
    // write; it must not latch the user-scrolled pause.
    act(() => {
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    // The active row moves further down; auto-follow must still work.
    const next = list.querySelectorAll<HTMLElement>('.chat-task-item')[2]!;
    Object.defineProperty(next, 'offsetTop', { configurable: true, value: 400 });
    Object.defineProperty(next, 'offsetHeight', { configurable: true, value: 30 });
    render({
      tasks: TASKS.map((task, index) =>
        index === 1
          ? { ...task, status: 'completed' as const }
          : index === 2
            ? { ...task, status: 'in_progress' as const }
            : task,
      ),
      open: true,
      onToggle,
    });
    expect(list.scrollTop).toBe(230); // 430 - 200
  });

  it('resumes auto-scroll after the user scrolls back to the active row', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const list = container.querySelector<HTMLOListElement>(
      '.chat-task-dock-list',
    )!;
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    const active = list.querySelector<HTMLElement>(
      '.chat-task-item.in_progress',
    )!;
    Object.defineProperty(active, 'offsetTop', { configurable: true, value: 250 });
    Object.defineProperty(active, 'offsetHeight', { configurable: true, value: 30 });

    // Auto-follow scrolls the active row into view (scrollTop 80).
    render({ tasks: [...TASKS], open: true, onToggle });
    expect(list.scrollTop).toBe(80);
    act(() => {
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    // The user scrolls up; the active row leaves the visible band and
    // snapshots must not yank their position.
    act(() => {
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    const scrolled = vi.spyOn(list, 'scrollTop', 'set');
    render({ tasks: [...TASKS], open: true, onToggle });
    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();

    // The user scrolls back until the active row is visible again —
    // auto-follow resumes on the next snapshot.
    act(() => {
      list.scrollTop = 80;
      list.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    const next = list.querySelectorAll<HTMLElement>('.chat-task-item')[2]!;
    Object.defineProperty(next, 'offsetTop', { configurable: true, value: 400 });
    Object.defineProperty(next, 'offsetHeight', { configurable: true, value: 30 });
    render({
      tasks: TASKS.map((task, index) =>
        index === 1
          ? { ...task, status: 'completed' as const }
          : index === 2
            ? { ...task, status: 'in_progress' as const }
            : task,
      ),
      open: true,
      onToggle,
    });
    expect(list.scrollTop).toBe(230); // 430 - 200
  });
});

describe('TaskDock collapsed pill', () => {
  it('renders a compact pill with the progress and opens on click', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: false, onToggle });

    expect(container.querySelector('.chat-task-dock')).toBeNull();
    const pill = container.querySelector<HTMLButtonElement>('.chat-task-pill');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('aria-expanded')).toBe('false');
    expect(pill!.textContent).toContain('Tasks');
    expect(pill!.textContent).toContain('1/3');

    act(() => pill!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('carries a mini progress bar sized by completion', () => {
    render({ tasks: TASKS, open: false, onToggle: vi.fn() });

    const bar = container.querySelector<HTMLDivElement>(
      '.chat-task-pill-bar i',
    );
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe('33%');

    const done = TASKS.map((task) => ({ ...task, status: 'completed' as const }));
    render({ tasks: done, open: false, onToggle: vi.fn() });
    const full = container.querySelector<HTMLDivElement>(
      '.chat-task-pill-bar i',
    );
    expect(full!.style.width).toBe('100%');
  });
});

