import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { resolveMaestroSpawn } from '../maestro/mcp-client.js';
import { resolveAbsolutePath } from '../maestro/paths.js';
import { runMaestroFlow, type ExecFn, type RunFlowDeps } from '../maestro/run-flow.js';

const inputSchema = z.object({
  suite: z.enum(['smoke', 'regression', 'shared']),
  flow: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase kebab-case only.'),
}).strict();

const outputSchema = z.object({
  result: z.enum(['Passed', 'Failed', 'Blocked']),
  runId: z.string(),
  relativeRunDir: z.string(),
  junitPath: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  message: z.string(),
});

const defaultWorkspaceAbs = resolveAbsolutePath(process.cwd(), env.MAESTRO_WORKSPACE);
const defaultArtifactDirAbs = resolveAbsolutePath(process.cwd(), env.MAESTRO_ARTIFACT_DIR);

export interface CreateRunMaestroFlowToolOptions extends Partial<RunFlowDeps> {
  enabled?: boolean;
  command?: string;
  workspaceAbs?: string;
  artifactDirAbs?: string;
  timeoutMs?: number;
  exec?: ExecFn;
  now?: () => Date;
  random?: () => string;
}

export function createRunMaestroFlowTool(options: CreateRunMaestroFlowToolOptions = {}) {
  return createTool({
    id: 'run_maestro_flow',
    description:
      'Run a checked-in Maestro flow (smoke, regression, or shared) by logical name. Writes a JUnit report and artifacts under artifacts/maestro/<run-id>/. Returns Passed only when Maestro completes successfully.',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      if (options.enabled === false) {
        return {
          result: 'Blocked' as const,
          runId: '',
          relativeRunDir: '',
          junitPath: '',
          stdout: '',
          stderr: '',
          timedOut: false,
          message: 'Maestro is not enabled. Set MAESTRO_ENABLED=true and install the Maestro CLI to run flows.',
        };
      }
      try {
        const result = await runMaestroFlow(input, {
          command: options.command ?? env.MAESTRO_COMMAND,
          workspaceAbs: options.workspaceAbs ?? defaultWorkspaceAbs,
          artifactDirAbs: options.artifactDirAbs ?? defaultArtifactDirAbs,
          timeoutMs: options.timeoutMs ?? env.MAESTRO_TIMEOUT_MS,
          exec: options.exec ?? defaultExec,
          now: options.now ?? (() => new Date()),
          random: options.random ?? (() => Math.random().toString(16).slice(2, 10)),
          realpath: options.realpath ?? ((p) => import('node:fs/promises').then((m) => m.realpath(p))),
          stat: options.stat ?? ((p) => import('node:fs/promises').then((m) => m.stat(p))),
          mkdir: options.mkdir ?? ((p) => import('node:fs/promises').then((m) => m.mkdir(p, { recursive: true }) as Promise<void>)),
          writeFile: options.writeFile ?? ((p, d) => import('node:fs/promises').then((m) => m.writeFile(p, d))),
        });
        return {
          result: result.result,
          runId: result.runId,
          relativeRunDir: result.relativeRunDir,
          junitPath: result.relativeRunDir ? `${result.relativeRunDir}/junit.xml` : '',
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          message: result.message,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const safe = /^(Unsupported Maestro|Invalid Maestro|Resolved Maestro flow)/.test(message);
        return {
          result: 'Blocked' as const,
          runId: '',
          relativeRunDir: '',
          junitPath: '',
          stdout: '',
          stderr: '',
          timedOut: false,
          message: safe
            ? message
            : 'Maestro flow could not run. Check that the workspace and flow file exist.',
        };
      }
    },
  });
}

const defaultExec: ExecFn = async (file, args, opts) => {
  const { execFile } = await import('node:child_process');
  const { command, preArgs } = resolveMaestroSpawn(file);
  return new Promise((resolve) => {
    execFile(command, [...preArgs, ...(args as string[])], opts, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM');
      const rawCode = err ? (err as NodeJS.ErrnoException).code : undefined;
      const code: number | null = !err ? 0 : timedOut ? null : typeof rawCode === 'number' ? rawCode : null;
      resolve({
        code,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut,
      });
    });
  });
};

export const runMaestroFlowTool = createRunMaestroFlowTool({
  enabled: env.MAESTRO_ENABLED === 'true',
});
