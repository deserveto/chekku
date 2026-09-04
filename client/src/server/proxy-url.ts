const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const ROOT_CUSTOM_ROUTES = new Set([
  'healthz',
  'models',
]);

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Fixed allowlist of (method, path shape) pairs the browser proxy serves —
 * the complete set of Mastra native routes the client's `@mastra/client-js`
 * consumers use (agent catalog, stored-agent CRUD, memory-thread reads and
 * renames). Every other native route on the agent server is a server-side
 * transport with no browser consumer: the per-agent run drivers
 * (`generate`, `send-message`, `queue-message`), thread actions
 * (`abort`, `clone`, `subscribe`), stored-agent versioning (`activate`,
 * `restore`, `export`), tracing/tools/networks, and the workflow engine
 * API. The agent server runs without an auth provider, so proxying any of
 * them would let any signed-in user drive any agent outside the guarded
 * `/runs` surface (no 409 lock, 429 caps, watchdog, prompt bounds, or
 * thread-ownership collapse). `:id` matches one safe path segment.
 */
const AGENT_PROXY_ALLOWLIST: ReadonlyArray<{
  methods: ReadonlySet<string>;
  shape: readonly string[];
}> = [
  { methods: READ_METHODS, shape: ['agents'] },
  { methods: READ_METHODS, shape: ['agents', ':id'] },
  {
    methods: new Set(['GET', 'HEAD', 'POST']),
    shape: ['stored', 'agents'],
  },
  { methods: READ_METHODS, shape: ['stored', 'agents', ':id'] },
  {
    methods: new Set(['PATCH', 'PUT', 'DELETE']),
    shape: ['stored', 'agents', ':id'],
  },
  { methods: READ_METHODS, shape: ['memory', 'threads'] },
  {
    methods: new Set(['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE']),
    shape: ['memory', 'threads', ':id'],
  },
  {
    methods: READ_METHODS,
    shape: ['memory', 'threads', ':id', 'messages'],
  },
];

function matchesShape(
  segments: readonly string[],
  shape: readonly string[],
): boolean {
  if (segments.length !== shape.length) return false;
  for (let index = 0; index < shape.length; index += 1) {
    const pattern = shape[index];
    if (pattern === ':id') {
      if (!SAFE_SEGMENT.test(segments[index])) return false;
    } else if (segments[index] !== pattern) {
      return false;
    }
  }
  return true;
}

function isAllowedProxyRoute(method: string, segments: readonly string[]): boolean {
  return AGENT_PROXY_ALLOWLIST.some(
    (entry) => entry.methods.has(method) && matchesShape(segments, entry.shape),
  );
}

export function normalizeAgentProxyPath(
  path: readonly string[],
  method: string,
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

  if (isRootCustomRoute) {
    if (!READ_METHODS.has(method)) {
      throw new Error('This agent API route is not available through the agent proxy');
    }
    return [...path];
  }

  const normalized = path[0] === 'api' ? [...path] : ['api', ...path];

  // Mastra's native workflow HTTP API is a server-side transport with no
  // browser consumers: the app workflows (weekly-social-drafts, ...) are
  // triggered server-side over AGENT_URL directly, never through this
  // proxy. Registering a durable agent also auto-registers a general-purpose
  // engine workflow (`durable-agentic-loop`) whose input
  // accepts caller-chosen agent ids and run options, and the agent server
  // runs without an auth provider — so proxying this namespace would let
  // any signed-in user drive any agent outside the guarded `/runs` surface.
  if (normalized[0] === 'api' && normalized[1] === 'workflows') {
    throw new Error('Workflow API is not available through the agent proxy');
  }

  // Everything else the browser may touch is on the fixed allowlist above;
  // any other native agent-server route stays server-side only.
  if (!isAllowedProxyRoute(method, normalized.slice(1))) {
    throw new Error('This agent API route is not available through the agent proxy');
  }

  return normalized;
}

export function buildAgentProxyUrl(
  baseUrl: string,
  path: readonly string[],
  search: string,
  method: string,
): string {
  const normalizedPath = normalizeAgentProxyPath(path, method);

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
