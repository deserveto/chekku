'use client';

import { useEffect, useState } from 'react';
import { listAllAgents } from '@/lib/stored-agents';

const STORAGE_KEY = 'chekku-default-agent-id';

/** Reads the preferred default agent id, or null when unset/unavailable. */
export function readDefaultAgentId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Removes a stored preference that no longer resolves to a real agent. */
export function clearDefaultAgentId(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

/**
 * Workspace preference: which agent "New chat" starts with. Stored in
 * localStorage only — a browser-local UI preference, never agent data.
 */
export function DefaultAgentField() {
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [selected, setSelected] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listAllAgents()
      .catch(() => [])
      .then((rows) => {
        if (cancelled) return;
        setAgents(rows.map((agent) => ({ id: agent.id, name: agent.name })));
        setSelected(readDefaultAgentId() ?? '');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (id: string) => {
    setSelected(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort preference
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <label className="studio-field">
      <span>Default agent for new chats</span>
      <select
        value={selected}
        onChange={(event) => save(event.target.value)}
      >
        <option value="">Main Agent (server default)</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <small>
        {saved
          ? 'Saved.'
          : 'Used by "New chat" in the sidebar when no agent is open.'}
      </small>
    </label>
  );
}
