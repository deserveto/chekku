const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const ROOT_CUSTOM_ROUTES = new Set([
  'healthz',
  'models',
]);

export function buildAgentProxyUrl(
  baseUrl: string,
  path: readonly string[],
  search: string,
): string {
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

  const normalizedPath =
    path[0] === 'api' || isRootCustomRoute
      ? path
      : ['api', ...path];

  const base = baseUrl.replace(/\/+$/, '');
  const suffix = normalizedPath
    .map(encodeURIComponent)
    .join('/');

  return `${base}/${suffix}${search}`;
}
