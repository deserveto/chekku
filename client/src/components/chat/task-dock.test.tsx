// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDock } from './task-dock';
import type { TaskItem } from '@/lib/task-list';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
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

  it('closes from the scrim tap target', () => {
    const onToggle = vi.fn();
    render({ tasks: TASKS, open: true, onToggle });

    const scrim = container.querySelector<HTMLButtonElement>(
      '.chat-task-scrim',
    );
    expect(scrim).not.toBeNull();
    act(() => scrim!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
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

