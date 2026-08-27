const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const ROOT_CUSTOM_ROUTES = new Set([
  'healthz',
  'models',
]);

export function normalizeAgentProxyPath(
  path: readonly string[],
): string[] {
  if (path.length === 0) {
    throw new Error('Agent proxy path is required');
  }

  for (const segment of path) {
    if (!SAFE_SEGMENT.test(segment)) {
      throw new Error(
        `Unsafe agent proxy path segment: ${segment}`,
      );
    }
  }

  const isRootCustomRoute =
    path.length === 1 &&
    ROOT_CUSTOM_ROUTES.has(path[0]);

  const normalized = path[0] === 'api' || isRootCustomRoute
    ? [...path]
    : ['api', ...path];

  // Mastra's native workflow HTTP API is a server-side transport with no
  // browser consumers: the app workflows (weekly-social-drafts, ...) are
  // triggered server-side over AGENT_URL directly, never through this
  // proxy. Wrapping an agent with `createDurableAgent` also auto-registers
  // a general-purpose engine workflow (`durable-agentic-loop`) whose input
  // accepts caller-chosen agent ids and run options, and the agent server
  // runs without an auth provider — so proxying this namespace would let
  // any signed-in user drive any agent outside the guarded `/runs` surface
  // (no 409 lock, 429 caps, watchdog, or ownership collapse). Block it.
  if (normalized[0] === 'api' && normalized[1] === 'workflows') {
    throw new Error('Workflow API is not available through the agent proxy');
  }

  return normalized;
}

export function buildAgentProxyUrl(
  baseUrl: string,
  path: readonly string[],
  search: string,
): string {
  const normalizedPath = normalizeAgentProxyPath(path);

  const base = baseUrl.replace(/\/+$/, '');
  const suffix = normalizedPath
    .map(encodeURIComponent)
    .join('/');

  return `${base}/${suffix}${search}`;
}

/**
 * Builds the upstream URL for the server-owned agent-run surface
 * (`POST /runs`, `GET /runs/active`, `GET /runs/:runId/events`, ...).
 * An empty path targets the run-start route itself.
 */
export function buildRunsProxyUrl(
  baseUrl: string,
  path: readonly string[],
  search: string,
): string {
  if (path.length === 0) {
    return `${baseUrl.replace(/\/+$/, '')}/runs${search}`;
  }

  for (const segment of path) {
    if (!SAFE_SEGMENT.test(segment)) {
      throw new Error(`Unsafe run proxy path segment: ${segment}`);
    }
  }

  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.map(encodeURIComponent).join('/');
  return `${base}/runs/${suffix}${search}`;
}
