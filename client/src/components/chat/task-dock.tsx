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

export function TaskDock({
  tasks,
  updatedAt,
  open,
  onToggle,
}: {
  tasks: TaskItem[];
  /** ISO timestamp of the latest snapshot; absent for Memory-restored lists. */
  updatedAt?: string;
  /** Whether the dock body is expanded (desktop column) or shown as drawer. */
  open: boolean;
  onToggle: () => void;
}) {
  const headingId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const { completed, total } = taskProgress(tasks);
  const allCompleted = total > 0 && completed === total;
  // Keeps the "updated Xs ago" line fresh without a snapshot arriving.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Escape closes the expanded dock (and the narrow-viewport drawer); a
  // keyboard user gets an out without tabbing to the collapse button.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onToggle]);

  // Drawer mode: move focus into the dock so keyboard users land inside the
  // surfaced panel instead of behind the scrim.
  useEffect(() => {
    if (open && window.innerWidth <= DRAWER_BREAKPOINT_PX) {
      collapseRef.current?.focus();
    }
  }, [open]);

  // Keep the active task visible: when the in-progress row sits below the
  // dock's scroll fold, bring it into view. Manual scroll math (instead of
  // scrollIntoView) so the page behind the dock never moves.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('.chat-task-item.in_progress');
    if (!active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
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

  if (!open) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return (
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
  }

  return (
    <>
      {/* Narrow-viewport scrim: tap-outside closes the drawer. Hidden by CSS
          on wide screens where the dock is a layout column, not an overlay. */}
      <button
        className="chat-task-scrim"
        type="button"
        aria-label="Close task panel"
        tabIndex={-1}
        onClick={onToggle}
      />
      <aside className="chat-task-dock" aria-labelledby={headingId}>
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
      </aside>
    </>
  );
}
