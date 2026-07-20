'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudioNav } from '@/components/studio/studio-nav';
import { BrandMark } from '@/components/ui/brand-mark';
import {
  AgentApiError,
  deleteStoredAgent,
  ensureStoredAgentUsesServerGateway,
  listAllAgents,
} from '@/lib/stored-agents';
import { buildChatHref } from '@/lib/chat-route';
import { loadModelRegistry } from '@/lib/model-registry';
import { createOwnedThreadId } from '@/lib/thread-id';
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
      const modelRegistry = await loadModelRegistry();
      await ensureStoredAgentUsesServerGateway(target, modelRegistry);
      const threadId = createOwnedThreadId(target.id, resourceId);
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

  const remove = async (agent: ChekkuAgentSummary) => {
    if (
      RESERVED_AGENT_IDS.has(agent.id) ||
      agent.source !== 'stored' ||
      !window.confirm(`Delete “${agent.name}”? This cannot be undone.`)
    ) {
      return;
    }

    setBusyId(agent.id);
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
      setBusyId(undefined);
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
              <p className="studio-eyebrow">Available agents</p>
              <h2>Registry</h2>
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
                        {agent.id === 'qa-web-agent' ? '◎' : agent.id === 'qa-android-agent' ? '▷' : '◇'}
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
                          disabled={busyId === agent.id}
                          onClick={() => void remove(agent)}
                          aria-label={`Delete ${agent.name}`}
                        >
                          {busyId === agent.id ? '…' : '×'}
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
    </div>
  );
}
