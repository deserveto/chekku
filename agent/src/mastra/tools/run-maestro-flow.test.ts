import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createRunMaestroFlowTool } from './run-maestro-flow.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const ARTIFACTS = process.platform === 'win32' ? 'C:\\artifacts' : '/artifacts';

function makeTool(overrides: Record<string, unknown> = {}) {
  return createRunMaestroFlowTool({
    command: 'maestro',
    workspaceAbs: WORKSPACE,
    artifactDirAbs: ARTIFACTS,
    timeoutMs: 120000,
    now: () => new Date('2026-07-17T00:00:00Z'),
    random: () => 'deadbeef',
    exec: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }),
    realpath: async (p: string) => p,
    stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    ...overrides,
  });
}

type ToolOutput = {
  result: string;
  runId: string;
  relativeRunDir: string;
  junitPath: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  message: string;
};

describe('createRunMaestroFlowTool', () => {
  it('has id run_maestro_flow and a strict { suite, flow } input schema', async () => {
    const tool = makeTool();
    expect(tool.id).toBe('run_maestro_flow');

    const schema = tool.inputSchema as unknown as z.ZodTypeAny;
    expect(schema.safeParse({ suite: 'smoke', flow: 'login' }).success).toBe(true);
    expect(schema.safeParse({ suite: 'smoke' }).success).toBe(false);
    expect(schema.safeParse({ suite: 'evil', flow: 'x' }).success).toBe(false);
    expect(schema.safeParse({ suite: 'smoke', flow: 'a/b' }).success).toBe(false);
  });

  it('returns a Passed result with a relative run dir for a successful run', async () => {
    const tool = makeTool();
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never) as ToolOutput;

    expect(output.result).toBe('Passed');
    expect(output.runId).toBe('20260717000000_deadbeef');
    expect(output.relativeRunDir).toBe('20260717000000_deadbeef');
    expect(output.junitPath).toBe('20260717000000_deadbeef/junit.xml');
  });

  it('returns Blocked when disabled', async () => {
    const tool = createRunMaestroFlowTool({ enabled: false });
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never) as ToolOutput;

    expect(output.result).toBe('Blocked');
    expect(output.message).toMatch(/not enabled|disabled/i);
  });

  it('returns Blocked with a sanitized message when the workspace is missing (no path leak)', async () => {
    const secret = process.platform === 'win32' ? 'C:\\secret\\ws' : '/secret/ws';
    const tool = makeTool({
      realpath: async () => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${secret}'`), { code: 'ENOENT' });
      },
    });
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never) as ToolOutput;

    expect(output.result).toBe('Blocked');
    expect(output.message).not.toContain(secret);
    expect(output.message).toMatch(/could not run|workspace/i);
  });

  it('surfaces the safe resolver message when the flow file is missing', async () => {
    const tool = makeTool({
      stat: async () => ({ isFile: () => false, isDirectory: () => false }),
    });
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never) as ToolOutput;

    expect(output.result).toBe('Blocked');
    expect(output.message).toMatch(/not a regular file/i);
  });
});
