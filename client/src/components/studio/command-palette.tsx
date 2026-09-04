'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AgentIcon } from '@/components/agents/agent-icon';
import { useStudioNavigation } from '@/components/studio/studio-navigation';
import { resolveAgentChatThreadId } from '@/lib/agent-chat-entry';
import { listAllAgents } from '@/lib/stored-agents';
import { buildChatHref } from '@/lib/chat-route';
import type { AgentIconId } from '@/lib/agent-icons';
import type { ChekkuAgentSummary } from '@/lib/types';


interface PaletteCommand {
  id: string;
  icon: AgentIconId;
  label: string;
  hint: string;
  run: () => Promise<void> | void;
}

/**
 * Global ⌘K/Ctrl+K palette: jump straight into an agent chat (resume
 * semantics, same entry path as the catalog) or navigate the studio.
 * Navigation-only by design — no state mutation from the palette.
 */
export function CommandPalette({ resourceId }: { resourceId: string }) {
  const router = useRouter();
  const { canNavigate } = useStudioNavigation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const openPalette = useCallback(() => {
    setQuery('');
    setActiveIndex(0);
    setBusyId(null);
    setErrorText(null);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        if (open) close();
        else openPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close, openPalette]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    let cancelled = false;
    void listAllAgents()
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);


  const guardedPush = useCallback(
    (href: string) => {
      if (!canNavigate(href)) return;
      router.push(href);
    },
    [canNavigate, router],
  );
  const commands = useMemo<PaletteCommand[]>(() => {
    const agentCommands: PaletteCommand[] = agents.map((agent) => ({
      id: `agent-${agent.id}`,
      icon: agent.iconKey ?? 'spark',
      label: `Open chat — ${agent.name}`,
      hint: 'Agent',
      run: async () => {
        setBusyId(agent.id);
        setErrorText(null);
        try {
          const threadId = await resolveAgentChatThreadId(resourceId, agent);
          const href = buildChatHref(agent.id, threadId);
          if (!canNavigate(href)) {
            setBusyId(null);
            return;
          }
          router.push(href);
        } catch {
          setErrorText('Could not open the chat. Check the agent registry.');
          setBusyId(null);
        }
      },
    }));
    const navigation: PaletteCommand[] = [
      {
        id: 'nav-agents',
        icon: 'network',
        label: 'Agent catalog',
        hint: 'Go to',
        run: () => guardedPush('/agents'),
      },
      {
        id: 'nav-new-agent',
        icon: 'spark',
        label: 'New agent',
        hint: 'Go to',
        run: () => guardedPush('/agents/new'),
      },
      {
        id: 'nav-reports',
        icon: 'chart',
        label: 'Reports',
        hint: 'Go to',
        run: () => guardedPush('/reports'),
      },
      {
        id: 'nav-social-posts',
        icon: 'pen',
        label: 'Social posts',
        hint: 'Go to',
        run: () => guardedPush('/social-posts'),
      },
      {
        id: 'nav-settings',
        icon: 'settings',
        label: 'Settings',
        hint: 'Go to',
        run: () => guardedPush('/settings'),
      },
    ];
    return [...agentCommands, ...navigation];
  }, [agents, canNavigate, guardedPush, resourceId, router]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      command.label.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  const runCommand = useCallback(
    (command: PaletteCommand | undefined) => {
      if (!command) return;
      close();
      void command.run();
    },
    [close],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(filtered.length - 1, 0)),
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(filtered[activeIndex]);
    }
  };

  if (!open) return null;

  const activeId = filtered[activeIndex]?.id;

  return (
    <div
      className="cmd-palette-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="cmd-palette-input"
          role="combobox"
          aria-expanded={filtered.length > 0}
          aria-controls="cmd-palette-listbox"
          aria-activedescendant={
            activeId !== undefined ? `cmd-opt-${activeId}` : undefined
          }
          aria-autocomplete="list"
          aria-label="Search commands"
          placeholder="Jump to an agent or page…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div
          className="cmd-palette-list"
          id="cmd-palette-listbox"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.map((command, index) => (
            <button
              key={command.id}
              id={`cmd-opt-${command.id}`}
              role="option"
              type="button"
              aria-selected={index === activeIndex}
              className={`cmd-palette-option${
                index === activeIndex ? ' active' : ''
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runCommand(command)}
              disabled={busyId === command.id}
            >
              <span className="cmd-palette-glyph" aria-hidden="true">
                <AgentIcon icon={command.icon} />
              </span>
              <span className="cmd-palette-label">{command.label}</span>
              {busyId === command.id ? (
                <span className="cmd-palette-hint">Preparing…</span>
              ) : (
                <span className="cmd-palette-hint">{command.hint}</span>
              )}
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="cmd-palette-empty">No matches.</p>
          ) : null}
        </div>
        <div className="cmd-palette-foot">
          {errorText ?? '↑↓ navigate · ↵ open · esc close'}
        </div>
      </div>
    </div>
  );
}
