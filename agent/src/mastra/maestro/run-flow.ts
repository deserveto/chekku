import { join, relative } from 'node:path';

import { resolveMaestroFlowPath } from './flow-path.js';

import { sanitizeMaestroEnv } from './mcp-client.js';

export const MAX_OUTPUT_CHARS = 65_536;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecFn {
  (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; cwd: string; env: Record<string, string> }): Promise<ExecResult>;
}

export interface RunFlowDeps {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean }>;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
}

export interface RunFlowOptions extends RunFlowDeps {
  command: string;
  workspaceAbs: string;
  artifactDirAbs: string;
  timeoutMs: number;
  maxBuffer?: number;
  exec: ExecFn;
  now: () => Date;
  random: () => string;
}

export interface RunFlowInput {
  suite: string;
  flow: string;
}

export interface RunFlowResult {
  result: 'Passed' | 'Failed' | 'Blocked';
  runId: string;
  runDir: string;
  relativeRunDir: string;
  junitPath: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  message: string;
}

function boundOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS - 1)}…`;
}

export async function runMaestroFlow(
  input: RunFlowInput,
  options: RunFlowOptions,
): Promise<RunFlowResult> {
  const resolved = await resolveMaestroFlowPath(input, {
    workspaceAbs: options.workspaceAbs,
    realpath: options.realpath,
    stat: options.stat,
  });

  const timestamp = options.now().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '');
  const runId = `${timestamp}_${options.random()}`;
  const runDir = join(options.artifactDirAbs, runId);
  await options.mkdir(runDir);

  const junitPath = join(runDir, 'junit.xml');
  const argv = [
    'test',
    '--format', 'junit',
    '--output', junitPath,
    '--test-output-dir', runDir,
    resolved.absolutePath,
  ];

  const execResult = await options.exec(options.command, argv, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? MAX_OUTPUT_CHARS * 16,
    cwd: options.workspaceAbs,
    env: sanitizeMaestroEnv(),
  });

  const stdout = boundOutput(execResult.stdout);
  const stderr = boundOutput(execResult.stderr);

  await options.writeFile(join(runDir, 'stdout.log'), stdout).catch(() => undefined);
  await options.writeFile(join(runDir, 'stderr.log'), stderr).catch(() => undefined);

  let result: RunFlowResult['result'];
  let message: string;
  if (execResult.timedOut) {
    result = 'Blocked';
    message = `Maestro run timed out after ${options.timeoutMs} ms.`;
  } else if (execResult.code === 0) {
    result = 'Passed';
    message = 'Maestro completed successfully.';
  } else if (execResult.code === null) {
    result = 'Blocked';
    message = 'Maestro run did not produce an exit code.';
  } else {
    result = 'Failed';
    message = `Maestro exited with code ${execResult.code}.`;
  }

  return {
    result,
    runId,
    runDir,
    relativeRunDir: relative(options.artifactDirAbs, runDir) || runId,
    junitPath,
    stdout,
    stderr,
    timedOut: execResult.timedOut,
    message,
  };
}
