import { isAbsolute, join, relative } from 'node:path';

const ALLOWED_SUITES = ['smoke', 'regression', 'shared'] as const;
export type MaestroSuite = (typeof ALLOWED_SUITES)[number];

const FLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ResolveFlowPathDeps {
  workspaceAbs: string;
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean }>;
}

export interface ResolvedFlowPath {
  absolutePath: string;
}

export function isMaestroSuite(value: string): value is MaestroSuite {
  return (ALLOWED_SUITES as readonly string[]).includes(value);
}

export function buildRelativeFlowPath(suite: string, flow: string): string {
  if (!isMaestroSuite(suite)) {
    throw new Error(`Unsupported Maestro flow suite: ${suite}. Use one of smoke, regression, shared.`);
  }
  if (!FLOW_NAME_PATTERN.test(flow)) {
    throw new Error(
      'Invalid Maestro flow name. Use lowercase kebab-case letters and digits only (no slashes, dots, or extensions).',
    );
  }
  return join(suite, `${flow}.yaml`);
}

export async function resolveMaestroFlowPath(
  input: { suite: string; flow: string },
  deps: ResolveFlowPathDeps,
): Promise<ResolvedFlowPath> {
  const relativeFlow = buildRelativeFlowPath(input.suite, input.flow);
  const candidate = join(deps.workspaceAbs, relativeFlow);
  const realWorkspace = await deps.realpath(deps.workspaceAbs);
  const realCandidate = await deps.realpath(candidate);

  const rel = relative(realWorkspace, realCandidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Resolved Maestro flow is outside the workspace.');
  }

  const stats = await deps.stat(realCandidate);
  if (!stats.isFile()) {
    throw new Error('Resolved Maestro flow is not a regular file.');
  }

  return { absolutePath: realCandidate };
}
