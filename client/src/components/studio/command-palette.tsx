'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { resolveAgentChatThreadId } from '@/lib/agent-chat-entry';
import { listAllAgents } from '@/lib/stored-agents';
import { buildChatHref } from '@/lib/chat-route';
import type { ChekkuAgentSummary } from '@/lib/types';

interface PaletteCommand {
  id: string;
  glyph: string;
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


  const commands = useMemo<PaletteCommand[]>(() => {
    const agentCommands: PaletteCommand[] = agents.map((agent) => ({
      id: `agent-${agent.id}`,
      glyph: '▶',
      label: `Open chat — ${agent.name}`,
      hint: 'Agent',
      run: async () => {
        setBusyId(agent.id);
        setErrorText(null);
        try {
          const threadId = await resolveAgentChatThreadId(resourceId, agent);
          router.push(buildChatHref(agent.id, threadId));
        } catch {
          setErrorText('Could not open the chat. Check the agent registry.');
          setBusyId(null);
        }
      },
    }));
    const navigation: PaletteCommand[] = [
      {
        id: 'nav-agents',
        glyph: '◇',
        label: 'Agent catalog',
        hint: 'Go to',
        run: () => router.push('/agents'),
      },
      {
        id: 'nav-new-agent',
        glyph: '＋',
        label: 'New agent',
        hint: 'Go to',
        run: () => router.push('/agents/new'),
      },
      {
        id: 'nav-reports',
        glyph: '≡',
        label: 'Reports',
        hint: 'Go to',
        run: () => router.push('/reports'),
      },
      {
        id: 'nav-social-posts',
        glyph: '✎',
        label: 'Social posts',
        hint: 'Go to',
        run: () => router.push('/social-posts'),
      },
      {
        id: 'nav-settings',
        glyph: '⚙',
        label: 'Settings',
        hint: 'Go to',
        run: () => router.push('/settings'),
      },
    ];
    return [...agentCommands, ...navigation];
  }, [agents, resourceId, router]);

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
                {command.glyph}
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
