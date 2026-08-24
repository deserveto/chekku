'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  taskProgress,
  type TaskItem,
  type TaskItemStatus,
} from '@/lib/task-list';

/**
 * Right-side Todo Dock for ChatStudio: renders the thread's live task list
 * (Mastra native Task Lists surfaced through `task-list` run events). This
 * is an auxiliary progress surface — the chat timeline stays the execution
 * narrative, task tools never render as generic tool cards.
 *
 * Wide screens render a layout column (`<aside>`). Below the breakpoint the
 * dock is an overlay drawer backed by a native `<dialog>` (`showModal`):
 * the browser owns dialog semantics, the focus trap, and Escape — matching
 * the repo's ConfirmationDialog pattern — and focus is restored to the
 * invoker on close.
 */

const STATUS_MARKS: Record<TaskItemStatus, string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
};

const STATUS_LABELS: Record<TaskItemStatus, string> = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'pending',
};

/** Below this viewport width the dock renders as a drawer with a scrim. */
const DRAWER_BREAKPOINT_PX = 1080;

function relativeTime(from: string, nowMs: number): string | null {
  const at = Date.parse(from);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Live drawer-mode flag; recomputes when the viewport crosses the
 *  breakpoint so an open dock switches surfaces correctly. */
function useDrawerMode(breakpointPx: number): boolean {
  const [isDrawer, setIsDrawer] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia !== 'function') {
      return window.innerWidth <= breakpointPx;
    }
    return window.matchMedia(`(max-width: ${breakpointPx}px)`).matches;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const onChange = (event: MediaQueryListEvent) =>
      setIsDrawer(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpointPx]);
  return isDrawer;
}

export function TaskDock({
  tasks,
  updatedAt,
  notice,
  open,
  onToggle,
}: {
  tasks: TaskItem[];
  /** ISO timestamp of the latest snapshot; absent for Memory-restored lists. */
  updatedAt?: string;
  /** Bounded last task-tool failure, surfaced inside the dock. */
  notice?: string;
  /** Whether the dock body is expanded (desktop column) or shown as drawer. */
  open: boolean;
  onToggle: () => void;
}) {
  const headingId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasDrawerOpenRef = useRef(false);
  // True while the user has scrolled the list away from the auto-scroll
  // target; snapshots must not yank their position (#8).
  const userScrolledRef = useRef(false);
  const { completed, total } = taskProgress(tasks);
  const allCompleted = total > 0 && completed === total;
  const isDrawer = useDrawerMode(DRAWER_BREAKPOINT_PX);
  // Keeps the "updated Xs ago" line fresh without a snapshot arriving.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Desktop column: Escape closes the dock, but only when no higher
  // overlay (open <dialog>, popover, or fullscreen element) owns it.
  // Drawer mode uses the native dialog `cancel` event instead.
  useEffect(() => {
    if (!open || isDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const higherOverlay =
        document.querySelector('dialog[open]') ||
        (document.fullscreenElement ?? null) ||
        document.querySelector('[popover]:not(:popover-open)');
      if (higherOverlay) return;
      onToggle();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isDrawer, onToggle]);

  // Drawer mode: native <dialog> lifecycle — save the invoker, show
  // modally, move focus in; on close restore focus. Keyed on both `open`
  // and `isDrawer` so crossing the breakpoint while open re-runs it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isDrawer) return;
    if (open) {
      if (!wasDrawerOpenRef.current) {
        restoreFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }
      if (dialog && !dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      collapseRef.current?.focus();
      wasDrawerOpenRef.current = true;
      return;
    }
    if (dialog?.open) {
      // jsdom lacks the dialog methods; the attribute fallback keeps the
      // open state observable there.
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    if (wasDrawerOpenRef.current && restoreFocusRef.current?.isConnected) {
      restoreFocusRef.current.focus();
    }
    wasDrawerOpenRef.current = false;
  }, [open, isDrawer]);

  // Native dialog cancel (Escape / close request) collapses the dock.
  useEffect(() => {
    if (!isDrawer) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onToggle();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [isDrawer, onToggle, open]);

  // Mark snapshots where the user's scroll position leaves the bottom
  // band as "user-driven"; the auto-scroll below stays paused until the
  // user returns near the active row.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      userScrolledRef.current = true;
    };
    list.addEventListener('scroll', onScroll);
    return () => list.removeEventListener('scroll', onScroll);
  }, []);

  // Keep the active task visible unless the user scrolled on their own:
  // when the in-progress row sits below the dock's scroll fold, bring it
  // into view. Manual scroll math (instead of scrollIntoView) so the page
  // behind the dock never moves.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (userScrolledRef.current) return;
    const active = list.querySelector<HTMLElement>('.chat-task-item.in_progress');
    if (!active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
    // A snapshot may replace the rows the user was reading; treat each
    // applied snapshot as a fresh interaction point only after it runs.
  }, [tasks]);

  useEffect(() => {
    if (!open || !updatedAt) return;
    const timer = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [open, updatedAt]);

  const updatedLabel = useMemo(
    () => (updatedAt ? relativeTime(updatedAt, nowTick) : null),
    [updatedAt, nowTick],
  );

  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const pill = (
    <button
      className="chat-task-pill"
      type="button"
      onClick={onToggle}
      aria-label={`Tasks ${completed} of ${total} completed. Open task panel`}
      aria-expanded={false}
    >
      <span className="chat-task-pill-bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span aria-hidden="true">{allCompleted ? '✓' : '◍'}</span> Tasks{' '}
      {completed}/{total}
    </button>
  );

  const body = (
    <>
      <header className="chat-task-dock-header">
        <h2 id={headingId}>
          Tasks{' '}
          <span className="chat-task-dock-count" aria-hidden="true">
            {completed}/{total}
          </span>
          <span className="studio-sr-only">
            {completed} of {total} completed
          </span>
        </h2>
        <button
          ref={collapseRef}
          type="button"
          onClick={onToggle}
          aria-label="Collapse task panel"
          aria-expanded
        >
          −
        </button>
      </header>

      {updatedLabel && (
        <p className="chat-task-dock-updated">
          <span aria-hidden="true">⟳</span> updated {updatedLabel}
        </p>
      )}

      {notice && (
        <p className="chat-task-dock-notice" role="status">
          <span aria-hidden="true">⚠</span> {notice}
        </p>
      )}

      <ol
        ref={listRef}
        className="chat-task-dock-list"
        aria-label="Agent task list"
      >
        {tasks.map((task) => (
          <li key={task.id} className={`chat-task-item ${task.status}`}>
            <span className="chat-task-mark" aria-hidden="true">
              {STATUS_MARKS[task.status]}
            </span>
            <span className="studio-sr-only">
              {STATUS_LABELS[task.status]}:{' '}
            </span>
            <div className="chat-task-copy">
              <span className="chat-task-content">{task.content}</span>
              {task.status === 'in_progress' &&
                task.activeForm !== task.content && (
                  <small className="chat-task-active">{task.activeForm}…</small>
                )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );

  if (isDrawer) {
    // Drawer: the native dialog provides the top layer, dialog semantics,
    // the focus trap, and the Escape/cancel path. The dialog stays mounted
    // (open state driven by the effect above) so close/focus-restore run
    // against a live node; the pill renders beside it while collapsed.
    return (
      <>
        {!open && pill}
        <dialog
          ref={dialogRef}
          className="chat-task-dock chat-task-dock-dialog"
          aria-labelledby={headingId}
          onClick={(event) => {
            // Clicks that reach the dialog element itself hit the backdrop
            // area around the drawer panel.
            if (event.target === event.currentTarget) onToggle();
          }}
        >
          {body}
        </dialog>
      </>
    );
  }

  if (!open) return pill;

  return <aside className="chat-task-dock" aria-labelledby={headingId}>{body}</aside>;
}
