'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudioNav } from '@/components/studio/studio-nav';
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

  const [runningAgentIds, setRunningAgentIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    let cancelled = false;
    void listActiveRuns()
      .then((runs) => {
        if (!cancelled) {
          setRunningAgentIds(new Set(runs.map((run) => run.agentId)));
        }
      })
      .catch(() => {
        // Without the run surface the catalog simply shows no run chips.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;

    return agents.filter((agent) =>
      [agent.name, agent.id, agent.description, modelLabel(agent)]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
  }, [agents, query]);

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
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />

      <main className="studio-main">
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

        <section className="studio-section">
          <div className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">Registry</p>
              <h2 ref={registryHeadingRef} tabIndex={-1}>Available agents</h2>
            </div>

            <label className="studio-search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agents, ids, or models"
              />
            </label>
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
            <div className="studio-empty-state">
              <BrandMark />
              <p>Loading the Mastra registry…</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="studio-empty-state">
              <BrandMark />
              <h3>No matching agents</h3>
              <p>Change the search term or create a stored agent.</p>
            </div>
          ) : (
            <div className="studio-agent-grid">
              {filtered.map((agent) => {
                const canEdit = agent.source === 'stored';
                const canDelete =
                  canEdit && !RESERVED_AGENT_IDS.has(agent.id);

                return (
                  <article className="studio-agent-card" key={agent.id}>
                    <div className="studio-agent-card-top">
                      <span className="studio-agent-glyph">
                        <AgentIcon icon={agent.iconKey} />
                      </span>
                      <span
                        className={`studio-source-badge ${agent.source}`}
                      >
                        {agent.source}
                      </span>
                    </div>

                    <div>
                      <h3>{agent.name}</h3>
                      <code>{agent.id}</code>
                    </div>

                    <p>
                      {agent.description ||
                        'No description has been provided for this agent.'}
                    </p>

                    <dl className="studio-agent-meta">
                      <div>
                        <dt>Model</dt>
                        <dd>{modelLabel(agent)}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{agent.status || 'ready'}</dd>
                      </div>
                    </dl>

                    <div className="studio-card-actions">
                      {runningAgentIds.has(agent.id) && (
                        <span className="studio-running-chip">
                          <span aria-hidden="true">●</span> Running
                        </span>
                      )}
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
                          className="studio-button"
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
            </div>
          )}
        </section>
      </main>
      <ConfirmationDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete agent?'}
        description="This permanently removes the stored agent. Its past conversations stay in Memory but can no longer be opened. Built-in agents are never affected."
        pending={Boolean(pendingDelete && deletingAgentId === pendingDelete.id)}
        fallbackFocusRef={registryHeadingRef}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
