import { describe, expect, it } from 'vitest';

import { runMaestroFlow, MAX_OUTPUT_CHARS } from '../run-flow.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const ARTIFACTS = process.platform === 'win32' ? 'C:\\artifacts' : '/artifacts';
const sep = process.platform === 'win32' ? '\\' : '/';

function passingDeps() {
  return {
    realpath: async (p: string) => p,
    stat: async () => ({ isFile: () => true, isDirectory: () => false }),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
  };
}

describe('runMaestroFlow', () => {
  it('builds an argv array with junit format, output, and test-output-dir — never a shell string', async () => {
    let recorded: { file: string; args: readonly string[] } | undefined;
    const result = await runMaestroFlow(
      { suite: 'smoke', flow: 'login' },
      {
        command: 'maestro',
        workspaceAbs: WORKSPACE,
        artifactDirAbs: ARTIFACTS,
        timeoutMs: 120000,
        now: () => new Date('2026-07-17T00:00:00Z'),
        random: () => 'deadbeef',
        exec: async (file, args) => {
          recorded = { file, args };
          return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
        },
        ...passingDeps(),
      },
    );

    expect(recorded).toBeDefined();
    expect(recorded!.file).toBe('maestro');
    expect(Array.isArray(recorded!.args)).toBe(true);
    expect(recorded!.args[0]).toBe('test');
    expect(recorded!.args).toContain('--format');
    expect(recorded!.args).toContain('junit');
    const outputIdx = recorded!.args.indexOf('--output');
    expect(recorded!.args[outputIdx + 1].endsWith(`${sep}junit.xml`)).toBe(true);
    const dirIdx = recorded!.args.indexOf('--test-output-dir');
    expect(recorded!.args[dirIdx + 1]).toContain('artifacts');
    expect(recorded!.args[recorded!.args.length - 1]).toBe(`${WORKSPACE}${sep}smoke${sep}login.yaml`);
    expect(result.result).toBe('Passed');
  });

  it('reports Failed on non-zero exit', async () => {
    const result = await runMaestroFlow(
      { suite: 'smoke', flow: 'login' },
      {
        command: 'maestro',
        workspaceAbs: WORKSPACE,
        artifactDirAbs: ARTIFACTS,
        timeoutMs: 120000,
        now: () => new Date('2026-07-17T00:00:00Z'),
        random: () => 'deadbeef',
        exec: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }),
        ...passingDeps(),
      },
    );

    expect(result.result).toBe('Failed');
    expect(result.stderr).toBe('boom');
  });

  it('reports Blocked when the run times out', async () => {
    const result = await runMaestroFlow(
      { suite: 'smoke', flow: 'login' },
      {
        command: 'maestro',
        workspaceAbs: WORKSPACE,
        artifactDirAbs: ARTIFACTS,
        timeoutMs: 120000,
        now: () => new Date('2026-07-17T00:00:00Z'),
        random: () => 'deadbeef',
        exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
        ...passingDeps(),
      },
    );

    expect(result.result).toBe('Blocked');
    expect(result.timedOut).toBe(true);
  });

  it('truncates output beyond the bounded limit', async () => {
    const huge = 'x'.repeat(MAX_OUTPUT_CHARS + 50);
    const result = await runMaestroFlow(
      { suite: 'smoke', flow: 'login' },
      {
        command: 'maestro',
        workspaceAbs: WORKSPACE,
        artifactDirAbs: ARTIFACTS,
        timeoutMs: 120000,
        now: () => new Date('2026-07-17T00:00:00Z'),
        random: () => 'deadbeef',
        exec: async () => ({ code: 0, stdout: huge, stderr: '', timedOut: false }),
        ...passingDeps(),
      },
    );

    expect(result.stdout.length).toBe(MAX_OUTPUT_CHARS);
    expect(result.stdout.endsWith('…')).toBe(true);
  });

  it('rejects when the flow file is missing', async () => {
    await expect(
      runMaestroFlow(
        { suite: 'smoke', flow: 'missing' },
        {
          command: 'maestro',
          workspaceAbs: WORKSPACE,
          artifactDirAbs: ARTIFACTS,
          timeoutMs: 120000,
          now: () => new Date('2026-07-17T00:00:00Z'),
          random: () => 'deadbeef',
          exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
          realpath: async (p: string) => p,
          stat: async () => ({ isFile: () => false, isDirectory: () => false }),
          mkdir: async () => undefined,
          writeFile: async () => undefined,
        },
      ),
    ).rejects.toThrow(/file/i);
  });

  it('passes a sanitized env to the subprocess (no secrets, keeps PATH/JAVA_HOME)', async () => {
    const original = { ...process.env };
    process.env.LLM_API_KEY = 'secret-llm';
    process.env.GARAGE_SECRET_ACCESS_KEY = 'secret-garage';
    process.env.RESEND_API_KEY = 'secret-resend';
    process.env.TELEGRAM_BOT_TOKEN = 'secret-tg';
    process.env.PATH = '/usr/bin';
    process.env.JAVA_HOME = '/java';

    let recorded: { env?: Record<string, string> } | undefined;
    try {
      await runMaestroFlow(
        { suite: 'smoke', flow: 'login' },
        {
          command: 'maestro',
          workspaceAbs: WORKSPACE,
          artifactDirAbs: ARTIFACTS,
          timeoutMs: 120000,
          now: () => new Date('2026-07-17T00:00:00Z'),
          random: () => 'deadbeef',
          exec: async (_file, _args, opts) => {
            recorded = { env: opts.env };
            return { code: 0, stdout: '', stderr: '', timedOut: false };
          },
          realpath: async (p: string) => p,
          stat: async () => ({ isFile: () => true, isDirectory: () => false }),
          mkdir: async () => undefined,
          writeFile: async () => undefined,
        },
      );

      expect(recorded?.env).toBeDefined();
      expect(recorded!.env!.PATH).toBe('/usr/bin');
      expect(recorded!.env!.JAVA_HOME).toBe('/java');
      expect(recorded!.env).not.toHaveProperty('LLM_API_KEY');
      expect(recorded!.env).not.toHaveProperty('GARAGE_SECRET_ACCESS_KEY');
      expect(recorded!.env).not.toHaveProperty('RESEND_API_KEY');
      expect(recorded!.env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
    } finally {
      // Restore process.env
      for (const k of Object.keys(process.env)) {
        if (!(k in original)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(original)) process.env[k] = v;
    }
  });
});
