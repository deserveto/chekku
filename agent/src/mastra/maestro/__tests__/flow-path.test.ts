import { describe, expect, it } from 'vitest';

import { resolveMaestroFlowPath } from '../flow-path.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const sep = process.platform === 'win32' ? '\\' : '/';

function deps(realpathResult: string = WORKSPACE, isFile = true) {
  return {
    realpath: async (p: string) => (p.endsWith('login.yaml') ? p : realpathResult),
    stat: async () => ({ isFile: () => isFile, isDirectory: () => false }),
  };
}

describe('resolveMaestroFlowPath', () => {
  it('resolves a logical { smoke, login } to <workspace>/smoke/login.yaml', async () => {
    const resolved = await resolveMaestroFlowPath(
      { suite: 'smoke', flow: 'login' },
      { workspaceAbs: WORKSPACE, ...deps() },
    );

    expect(resolved.absolutePath).toBe(`${WORKSPACE}${sep}smoke${sep}login.yaml`);
  });

  it('accepts only the three allowlisted suites', async () => {
    for (const suite of ['smoke', 'regression', 'shared'] as const) {
      const r = await resolveMaestroFlowPath(
        { suite, flow: 'login' },
        { workspaceAbs: WORKSPACE, ...deps() },
      );
      expect(r.absolutePath).toContain(`${suite}${sep}login.yaml`);
    }
  });

  it('rejects an unknown suite', async () => {
    await expect(
      resolveMaestroFlowPath(
        { suite: 'evil', flow: 'login' },
        { workspaceAbs: WORKSPACE, ...deps() },
      ),
    ).rejects.toThrow(/suite/i);
  });

  it('rejects a flow with a slash, dot, backslash, or traversal', async () => {
    for (const flow of ['a/b', 'a.yaml', 'a.yml', 'a\\b', '..', 'a/../b', 'A B', 'UPPER']) {
      await expect(
        resolveMaestroFlowPath(
          { suite: 'smoke', flow },
          { workspaceAbs: WORKSPACE, ...deps() },
        ),
      ).rejects.toThrow();
    }
  });

  it('rejects when the real path escapes the workspace after symlink resolution', async () => {
    const escapee = process.platform === 'win32' ? 'C:\\secret' : '/secret';
    await expect(
      resolveMaestroFlowPath(
        { suite: 'smoke', flow: 'login' },
        {
          workspaceAbs: WORKSPACE,
          realpath: async (p: string) => (p === WORKSPACE ? WORKSPACE : escapee),
          stat: async () => ({ isFile: () => true, isDirectory: () => false }),
        },
      ),
    ).rejects.toThrow(/outside|escape|workspace/i);
  });

  it('rejects cross-drive symlink escape on Windows (absolute relative path)', async () => {
    if (process.platform !== 'win32') return;
    await expect(
      resolveMaestroFlowPath(
        { suite: 'smoke', flow: 'login' },
        {
          workspaceAbs: 'C:\\ws',
          realpath: async (p: string) => (p === 'C:\\ws' ? 'C:\\ws' : 'D:\\secret\\login.yaml'),
          stat: async () => ({ isFile: () => true, isDirectory: () => false }),
        },
      ),
    ).rejects.toThrow(/outside|escape|workspace/i);
  });

  it('rejects when the resolved path is not a regular file', async () => {
    await expect(
      resolveMaestroFlowPath(
        { suite: 'smoke', flow: 'login' },
        {
          workspaceAbs: WORKSPACE,
          realpath: async (p: string) => p,
          stat: async () => ({ isFile: () => false, isDirectory: () => true }),
        },
      ),
    ).rejects.toThrow(/file/i);
  });
});
