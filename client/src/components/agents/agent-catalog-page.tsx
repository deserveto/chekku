'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentIcon } from '@/components/agents/agent-icon';
import { BrandMark } from '@/components/ui/brand-mark';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  AgentApiError,
  deleteStoredAgent,
  listAllAgents,
} from '@/lib/stored-agents';
import { resolveAgentChatThreadId } from '@/lib/agent-chat-entry';
import { listActiveRuns } from '@/lib/agent-runs';
import { buildChatHref } from '@/lib/chat-route';
import {
  RESERVED_AGENT_IDS,
  type ChekkuAgentSummary,
} from '@/lib/types';

function modelLabel(agent: ChekkuAgentSummary): string {
  if (!agent.model) return 'Server default';
  return `${agent.model.provider}/${agent.model.name}`;
}

export function AgentCatalogPage({
  resourceId,
}: {
  resourceId: string;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<ChekkuAgentSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<ChekkuAgentSummary>();
  const [deletingAgentId, setDeletingAgentId] = useState<string>();
  const deleteInFlightRef = useRef(false);
  const registryHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);

    try {
      setAgents(await listAllAgents());
    } catch (reason) {
      setError(
        reason instanceof AgentApiError
          ? reason.message
          : 'Could not load agents.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listAllAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof AgentApiError
            ? reason.message
            : 'Could not load agents.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const [activeFilter, setActiveFilter] = useState<'all' | 'code' | 'stored'>(
    'all',
  );

  const [runningAgentIds, setRunningAgentIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Run chips must track live run state: runs start and finish outside this
  // page's control, so poll the active-run surface while mounted (skipped
  // while the tab is hidden).
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listActiveRuns()
        .then((runs) => {
          if (!cancelled) {
            setRunningAgentIds(new Set(runs.map((run) => run.agentId)));
          }
        })
        .catch(() => {
          // Without the run surface the catalog simply shows no run chips.
        });
    };
    refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const counts = useMemo(() => {
    let code = 0;
    let stored = 0;
    for (const a of agents) {
      if (a.source === 'stored') stored += 1;
      else code += 1;
    }
    return { all: agents.length, code, stored };
  }, [agents]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (activeFilter !== 'all' && agent.source !== activeFilter) return false;
      if (!needle) return true;
      return [agent.name, agent.id, agent.description, modelLabel(agent)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
    });
  }, [agents, query, activeFilter]);

  const startChat = async (target: ChekkuAgentSummary) => {
    setBusyId(target.id);
    setError(undefined);

    try {
      const threadId = await resolveAgentChatThreadId(resourceId, target);
      router.push(buildChatHref(target.id, threadId));
    } catch (reason) {
      setError(
        reason instanceof AgentApiError
          ? reason.message
          : 'Could not prepare the agent for chat.',
      );
      setBusyId(undefined);
    }
  };

  const requestRemove = (agent: ChekkuAgentSummary) => {
    if (RESERVED_AGENT_IDS.has(agent.id) || agent.source !== 'stored') {
      return;
    }
    setPendingDelete(agent);
  };

  const remove = async () => {
    const agent = pendingDelete;
    if (!agent || deleteInFlightRef.current) return;

    deleteInFlightRef.current = true;
    setDeletingAgentId(agent.id);
    setError(undefined);

    try {
      await deleteStoredAgent(agent.id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof AgentApiError
          ? reason.message
          : 'Could not delete the agent.',
      );
    } finally {
      deleteInFlightRef.current = false;
      setDeletingAgentId(undefined);
      setPendingDelete(undefined);
    }
  };

  return (
    <>
      <header className="studio-page-header">
        <div>
          <p className="studio-eyebrow">Agent registry</p>
          <h1>Choose an agent or build your own.</h1>
          <p>
            Start a conversation with a ready agent, or create a focused
            agent with the model, tools, memory, and delegate it needs.
          </p>
        </div>

        <Link className="studio-button studio-button-primary" href="/agents/new">
          ＋ New agent
        </Link>
      </header>

      <section className="studio-section studio-registry-section">
        <div className="studio-registry-header">
          <div className="studio-registry-title">
            <h2 ref={registryHeadingRef} tabIndex={-1}>
              Available agents
            </h2>
          </div>

            <div className="studio-registry-controls">
              <div
                role="tablist"
                aria-label="Filter agents by source"
                className="studio-registry-tabs"
              >
                <button
                  role="tab"
                  type="button"
                  aria-selected={activeFilter === 'all'}
                  className={activeFilter === 'all' ? 'active' : ''}
                  onClick={() => setActiveFilter('all')}
                >
                  All <span className="studio-tab-count">{counts.all}</span>
                </button>
                <button
                  role="tab"
                  type="button"
                  aria-selected={activeFilter === 'code'}
                  className={activeFilter === 'code' ? 'active' : ''}
                  onClick={() => setActiveFilter('code')}
                >
                  Built-in <span className="studio-tab-count">{counts.code}</span>
                </button>
                <button
                  role="tab"
                  type="button"
                  aria-selected={activeFilter === 'stored'}
                  className={activeFilter === 'stored' ? 'active' : ''}
                  onClick={() => setActiveFilter('stored')}
                >
                  Custom <span className="studio-tab-count">{counts.stored}</span>
                </button>
              </div>

              <label className="studio-search studio-registry-search">
                <span aria-hidden="true" className="studio-search-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="7" cy="7" r="5" />
                    <path d="M11 11 L14 14" />
                  </svg>
                </span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search names, ids, or models"
                  aria-label="Search agents"
                />
                {query && (
                  <button
                    type="button"
                    className="studio-search-clear"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    ×
                  </button>
                )}
              </label>
            </div>
          </div>

          {error && (
            <div className="studio-alert studio-alert-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="studio-empty-state studio-registry-empty">
              <BrandMark />
              <p>Loading the Mastra registry…</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="studio-empty-state studio-registry-empty">
              <BrandMark />
              <h3>No matching agents</h3>
              <p>
                {query || activeFilter !== 'all'
                  ? 'No agents match your filters. Clear search or switch tabs.'
                  : 'Change the search term or create a stored agent.'}
              </p>
              {(query || activeFilter !== 'all') && (
                <button
                  type="button"
                  className="studio-button"
                  onClick={() => {
                    setQuery('');
                    setActiveFilter('all');
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="studio-agent-grid">
              {filtered.map((agent) => {
                const canEdit = agent.source === 'stored';
                const canDelete = canEdit && !RESERVED_AGENT_IDS.has(agent.id);
                const isRunning = runningAgentIds.has(agent.id);

                return (
                  <article
                    className={`studio-agent-card${isRunning ? ' is-running' : ''}`}
                    key={agent.id}
                  >
                    <div className="studio-agent-card-top">
                      <span className="studio-agent-glyph" aria-hidden="true">
                        <AgentIcon icon={agent.iconKey} />
                      </span>
                      <div className="studio-agent-card-badges">
                        {isRunning && (
                          <span className="studio-running-chip">
                            Running
                          </span>
                        )}
                        <span
                          className={`studio-source-badge ${agent.source}`}
                          title={
                            agent.source === 'stored'
                              ? 'Custom stored agent'
                              : 'Code-defined built-in'
                          }
                        >
                          {agent.source === 'stored' ? 'Custom' : 'Built-in'}
                        </span>
                      </div>
                    </div>

                    <div className="studio-agent-card-body">
                      <h3>{agent.name}</h3>
                      <code>{agent.id}</code>
                    </div>

                    <p className="studio-agent-card-desc">
                      {agent.description ||
                        'No description has been provided for this agent.'}
                    </p>

                    <div className="studio-card-actions">
                      <button
                        className="studio-button studio-button-primary"
                        type="button"
                        disabled={busyId === agent.id}
                        onClick={() => void startChat(agent)}
                      >
                        {busyId === agent.id ? 'Preparing…' : 'Open chat'}
                      </button>

                      {canEdit && (
                        <Link
                          className="studio-button studio-button-ghost"
                          href={`/agents/${encodeURIComponent(agent.id)}/edit`}
                        >
                          Edit
                        </Link>
                      )}

                      {canDelete && (
                        <button
                          className="studio-icon-button studio-danger"
                          type="button"
                          disabled={busyId === agent.id || Boolean(deletingAgentId)}
                          onClick={() => requestRemove(agent)}
                          aria-label={`Delete ${agent.name}`}
                          aria-haspopup="dialog"
                        >
                          {deletingAgentId === agent.id ? '…' : '×'}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}

              {!query.trim() && (
                <Link
                  className="studio-agent-card studio-agent-create-card"
                  href="/agents/new"
                  aria-label="Build your own agent"
                >
                  <span
                    className="studio-agent-create-glyph"
                    aria-hidden="true"
                  >
                    +
                  </span>
                  <span className="studio-agent-create-label">
                    Build your own agent
                  </span>
                </Link>
              )}
            </div>
              )}
        </section>
      <ConfirmationDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete agent?'}
        description="This permanently removes the stored agent. Its past conversations stay in Memory but can no longer be opened. Built-in agents are never affected."
        pending={Boolean(pendingDelete && deletingAgentId === pendingDelete.id)}
        fallbackFocusRef={registryHeadingRef}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
