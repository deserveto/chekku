'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudioNav } from '@/components/studio/studio-nav';
import { loadModelRegistry } from '@/lib/model-registry';
import {
  AgentApiError,
  createStoredAgent,
  getStoredAgent,
  listAllAgents,
  updateStoredAgent,
} from '@/lib/stored-agents';
import {
  agentIdIssueMessage,
  validateAgentId,
} from '@/lib/agents-helpers';
import {
  STUDIO_DELEGATE_IDS,
  STUDIO_MCP_CLIENT_IDS,
  STUDIO_TOOL_IDS,
  migrateStoredModelId,
} from '@/server/agent-payload';

type Values = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  memoryEnabled: boolean;
  tools: string[];
  agents: string[];
  mcpClients: string[];
};

const EMPTY: Values = {
  id: '',
  name: '',
  description: '',
  instructions: '',
  model: '',
  memoryEnabled: true,
  tools: [],
  agents: [],
  mcpClients: [],
};

function toggle(values: string[], id: string): string[] {
  return values.includes(id)
    ? values.filter((value) => value !== id)
    : [...values, id];
}

const TOOL_META: Record<string, { title: string; description: string; icon: string }> = {
  calculator: {
    title: 'Calculator',
    description: 'Evaluates deterministic arithmetic without relying on the model.',
    icon: '∑',
  },
  'get-current-time': {
    title: 'Current time',
    description: 'Returns time, date, day, and UTC offset for an IANA timezone.',
    icon: '◷',
  },
  'send-email': {
    title: 'Send email',
    description: 'Delivers an agent-produced artifact via Resend. Requires RESEND_API_KEY.',
    icon: '✉',
  },
};

const MCP_META: Record<string, { title: string; description: string; icon: string }> = {
  garage: {
    title: 'Garage',
    description: 'Create, read, list, replace, and delete agent-isolated text objects in Garage.',
    icon: 'G',
  },
  searxng: {
    title: 'SearXNG Search',
    description: 'Search the web through the server-owned SearXNG instance and return result snippets.',
    icon: 'S',
  },
};

function titleForTool(id: string): string {
  return TOOL_META[id]?.title ?? id;
}

function descriptionForTool(id: string): string {
  return TOOL_META[id]?.description ?? '';
}

function iconForTool(id: string): string {
  return TOOL_META[id]?.icon ?? '◆';
}


export function AgentBuilderPage({
  mode,
  agentId,
  resourceId,
}: {
  mode: 'create' | 'edit';
  agentId?: string;
  resourceId: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(EMPTY);
  const [models, setModels] = useState<string[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(undefined);

      try {
        const [modelRegistry, agents] = await Promise.all([
          loadModelRegistry(),
          listAllAgents(),
        ]);
        const modelIds = modelRegistry.models;

        if (cancelled) return;

        setModels(modelIds);
        setExistingIds(new Set(agents.map((agent) => agent.id)));

        if (mode === 'edit') {
          if (!agentId) throw new Error('Agent id is missing');
          const detail = await getStoredAgent(agentId);
          if (cancelled) return;

          const migratedModel = detail.model
            ? migrateStoredModelId(detail.model)
            : '';
          const fullModel = modelIds.includes(migratedModel)
            ? migratedModel
            : modelRegistry.defaultModel || modelIds[0] || '';

          setValues({
            id: detail.id,
            name: detail.name,
            description: detail.description || '',
            instructions: detail.instructions,
            model: fullModel,
            memoryEnabled: detail.memoryEnabled,
            tools: detail.tools,
            agents: detail.agents,
            mcpClients: detail.mcpClients,
          });
        } else {
          setValues((current) => ({
            ...current,
            model:
              current.model ||
              modelRegistry.defaultModel ||
              modelIds[0] ||
              '',
          }));
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof AgentApiError || reason instanceof Error
              ? reason.message
              : 'Could not load the agent builder.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, mode]);

  const duplicateIds = useMemo(() => {
    const copy = new Set(existingIds);
    if (mode === 'edit' && agentId) copy.delete(agentId);
    return copy;
  }, [agentId, existingIds, mode]);

  const idIssue =
    mode === 'create'
      ? validateAgentId(values.id, duplicateIds)
      : null;

  const valid =
    (mode === 'edit' || idIssue === null) &&
    values.name.trim().length > 0 &&
    values.instructions.trim().length > 0 &&
    values.model.trim().length > 0;

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    setError(undefined);

    const input = {
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      instructions: values.instructions.trim(),
      model: values.model,
      tools: values.tools,
      agents: values.agents,
      mcpClients: values.mcpClients,
      memoryEnabled: values.memoryEnabled,
    };

    try {
      if (mode === 'create') {
        await createStoredAgent(values.id.trim(), input);
      } else if (agentId) {
        await updateStoredAgent(agentId, input);
      }

      router.push('/agents');
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof AgentApiError || reason instanceof Error
          ? reason.message
          : 'Could not save the agent.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />

      <main className="studio-main studio-builder-main">
        <header className="studio-page-header studio-builder-header">
          <div>
            <p className="studio-eyebrow">Agent builder</p>
            <h1>{mode === 'create' ? 'Create an agent' : 'Edit agent'}</h1>
            <p>
              This form writes a stored-agent record. Mastra hydrates that
              record into a runtime Agent on the next request.
            </p>
          </div>

          <Link className="studio-button" href="/agents">
            ← Back to registry
          </Link>
        </header>

        {loading ? (
          <div className="studio-panel studio-builder-loading">
            Loading models and agent configuration…
          </div>
        ) : (
          <form className="studio-builder-layout" onSubmit={submit}>
            <section className="studio-panel studio-form-panel">
              <div className="studio-panel-heading">
                <span>01</span>
                <div>
                  <h2>Identity</h2>
                  <p>The permanent database identity and user-facing label.</p>
                </div>
              </div>

              <div className="studio-form-grid two">
                <label className="studio-field">
                  <span>Agent ID</span>
                  <input
                    value={values.id}
                    onChange={(event) => set('id', event.target.value)}
                    disabled={mode === 'edit' || submitting}
                    placeholder="research-assistant"
                    aria-invalid={Boolean(idIssue)}
                  />
                  {idIssue ? (
                    <small className="studio-field-error">
                      {agentIdIssueMessage(idIssue)}
                    </small>
                  ) : (
                    <small>Lowercase kebab-case. Fixed after creation.</small>
                  )}
                </label>

                <label className="studio-field">
                  <span>Display name</span>
                  <input
                    value={values.name}
                    onChange={(event) => set('name', event.target.value)}
                    disabled={submitting}
                    placeholder="Research Assistant"
                  />
                  <small>Shown in the registry and chat header.</small>
                </label>
              </div>

              <label className="studio-field">
                <span>Description</span>
                <input
                  value={values.description}
                  onChange={(event) =>
                    set('description', event.target.value)
                  }
                  disabled={submitting}
                  placeholder="A short summary of what this agent is for"
                />
              </label>
            </section>

            <section className="studio-panel studio-form-panel">
              <div className="studio-panel-heading">
                <span>02</span>
                <div>
                  <h2>Runtime</h2>
                  <p>Model routing and conversation memory.</p>
                </div>
              </div>

              <label className="studio-field">
                <span>Model</span>
                <select
                  value={values.model}
                  onChange={(event) => set('model', event.target.value)}
                  disabled={submitting || models.length === 0}
                >
                  {models.length === 0 ? (
                    <option value="">No models returned by /models</option>
                  ) : (
                    models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
                <small>
                  Uses the server-owned OpenAI-compatible endpoint. Credentials stay in agent/.env.
                </small>
              </label>

              <label className="studio-toggle-row">
                <input
                  type="checkbox"
                  checked={values.memoryEnabled}
                  onChange={(event) =>
                    set('memoryEnabled', event.target.checked)
                  }
                  disabled={submitting}
                />
                <span className="studio-toggle-track">
                  <i />
                </span>
                <span>
                  <strong>Conversation memory</strong>
                  <small>Keep the most recent 20 messages per thread.</small>
                </span>
              </label>
            </section>

            <section className="studio-panel studio-form-panel">
              <div className="studio-panel-heading">
                <span>03</span>
                <div>
                  <h2>Capabilities</h2>
                  <p>Registry-backed direct tools available to this agent.</p>
                </div>
              </div>

              <div className="studio-capability-grid">
                {STUDIO_TOOL_IDS.map((toolId) => {
                  const checked = values.tools.includes(toolId);
                  return (
                    <label
                      className={`studio-capability-card ${
                        checked ? 'selected' : ''
                      }`}
                      key={toolId}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          set('tools', toggle(values.tools, toolId))
                        }
                        disabled={submitting}
                      />
                      <span className="studio-capability-icon">
                        {iconForTool(toolId)}
                      </span>
                      <span>
                        <strong>{titleForTool(toolId)}</strong>
                        <small>{descriptionForTool(toolId)}</small>
                      </span>
                      <i>{checked ? '✓' : '+'}</i>
                    </label>
                  );
                })}
              </div>

              <div className="studio-capability-grid">
                {STUDIO_MCP_CLIENT_IDS.map((mcpClientId) => {
                  const checked = values.mcpClients.includes(mcpClientId);
                  const meta = MCP_META[mcpClientId];
                  return (
                    <label
                      className={`studio-capability-card ${
                        checked ? 'selected' : ''
                      }`}
                      key={mcpClientId}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          set('mcpClients', toggle(values.mcpClients, mcpClientId))
                        }
                        disabled={submitting}
                      />
                      <span className="studio-capability-icon">{meta.icon}</span>
                      <span>
                        <strong>{meta.title}</strong>
                        <small>{meta.description}</small>
                      </span>
                      <i>{checked ? '✓' : '+'}</i>
                    </label>
                  );
                })}
              </div>
            </section>

            <section className="studio-panel studio-form-panel">
              <div className="studio-panel-heading">
                <span>04</span>
                <div>
                  <h2>Delegation</h2>
                  <p>Specialized code-defined agents this agent may call.</p>
                </div>
              </div>

              <div className="studio-capability-grid">
                {STUDIO_DELEGATE_IDS.map((delegateId) => {
                  const checked = values.agents.includes(delegateId);
                  return (
                    <label
                      className={`studio-capability-card studio-delegate-card ${
                        checked ? 'selected' : ''
                      }`}
                      key={delegateId}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          set('agents', toggle(values.agents, delegateId))
                        }
                        disabled={submitting}
                      />
                      <span className="studio-capability-icon">◎</span>
                      <span>
                        <strong>QA Web Agent</strong>
                        <small>
                          Delegates website navigation, extraction, and browser
                          interaction to the browser-capable runtime.
                        </small>
                      </span>
                      <i>{checked ? '✓' : '+'}</i>
                    </label>
                  );
                })}
              </div>
            </section>

            <section className="studio-panel studio-form-panel studio-instructions-panel">
              <div className="studio-panel-heading">
                <span>05</span>
                <div>
                  <h2>Instructions</h2>
                  <p>The system behavior applied to every turn.</p>
                </div>
              </div>

              <label className="studio-field">
                <span>System instructions</span>
                <textarea
                  value={values.instructions}
                  onChange={(event) =>
                    set('instructions', event.target.value)
                  }
                  disabled={submitting}
                  rows={12}
                  placeholder="You are a careful research assistant…"
                />
                <small>
                  Be explicit about goals, constraints, output format, and when
                  delegation is appropriate.
                </small>
              </label>
            </section>

            {error && (
              <div className="studio-alert studio-alert-error" role="alert">
                {error}
              </div>
            )}

            <footer className="studio-builder-footer">
              <Link className="studio-button" href="/agents">
                Cancel
              </Link>
              <button
                className="studio-button studio-button-primary"
                type="submit"
                disabled={!valid || submitting}
              >
                {submitting
                  ? 'Saving…'
                  : mode === 'create'
                    ? 'Create agent'
                    : 'Save changes'}
              </button>
            </footer>
          </form>
        )}
      </main>
    </div>
  );
}
