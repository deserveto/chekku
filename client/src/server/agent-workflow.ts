import 'server-only';

import { getDownstreamToken } from './auth';

/**
 * Start an agent-server workflow fire-and-forget over Mastra's native
 * workflow HTTP API (create-run + start), authenticated with the same
 * downstream token the `/api/agent/*` proxy attaches.
 *
 * This is a server-side transport with no session cookie, so it must call
 * the agent server DIRECTLY (not the browser `mastraClient` loop-back
 * through `/api/agent/*`). Mirrors the pattern in
 * `client/src/app/api/storage/social-posts/run-weekly-drafts/route.ts`.
 */
export interface AgentWorkflowTriggerDeps {
  agentUrl?: string;
  fetchImpl?: typeof fetch;
  getToken?: (userId: string) => Promise<string | null>;
}

export async function startAgentWorkflow(
  userId: string,
  workflowId: string,
  inputData: Record<string, unknown>,
  deps: AgentWorkflowTriggerDeps = {},
): Promise<void> {
  const agentUrl = (deps.agentUrl ?? process.env.AGENT_URL ?? 'http://localhost:4111').replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getToken ?? getDownstreamToken;

  const token = await getToken(userId);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // 1. Create a run record and obtain its runId.
  const createRes = await fetchImpl(`${agentUrl}/api/workflows/${workflowId}/create-run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    // @ts-expect-error duplex is not in the lib.dom types but is required by Node.
    duplex: 'half',
  });
  if (!createRes.ok) {
    throw new Error(`create-run failed with status ${createRes.status}`);
  }
  const created = (await createRes.json().catch(() => ({}))) as { runId?: string };
  const runId = created?.runId;
  if (!runId) {
    throw new Error('create-run returned no runId');
  }

  // 2. Start the run fire-and-forget — the workflow continues server-side
  // and observers watch the post metadata instead of the run.
  const startRes = await fetchImpl(
    `${agentUrl}/api/workflows/${workflowId}/start?runId=${encodeURIComponent(runId)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ inputData }),
      // @ts-expect-error duplex is not in the lib.dom types but is required by Node.
      duplex: 'half',
    },
  );
  if (!startRes.ok) {
    throw new Error(`start failed with status ${startRes.status}`);
  }
}
