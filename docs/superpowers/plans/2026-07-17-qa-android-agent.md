# QA Android Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a code-defined Mastra agent `qa-android-agent` that performs Android QA through Maestro's local MCP server, with an allowlisted tool surface, request-context approval, and a curated checked-in-flow runner.

**Architecture:** The agent reuses `getServerModel()`, `Memory`, and `gatewayCompatibilityProcessor` like `qa-web-agent`. A trusted, env-gated `MCPClient` connects to `maestro mcp` over stdio and exposes only an explicit allowlist of its tools. A separate curated `run_maestro_flow` tool resolves logical `{ suite, flow }` names to checked-in YAML and runs them via `execFile` (never a shell string) with JUnit output, timeouts, and bounded output. Approval is decided by one pure classifier driven by a new `mobileAccess` request-context field.

**Tech Stack:** Mastra (`@mastra/core/agent`, `@mastra/core/tools`, `@mastra/mcp` `MCPClient`), Zod 3.25.76, Vitest 4, Next.js (client), TypeScript strict.

## Global Constraints

- Node >= 22.22; TypeScript strict mode; named exports; external-then-blank-then-internal import ordering.
- Zod pinned to `3.25.76`; do not introduce Zod 4.
- No new test runner — Vitest only; tests live alongside modules or in `__tests__/`.
- Never expose secrets, raw credentials, provider responses, or absolute physical flow paths in errors or tool output.
- Never execute commands through an interpolated shell string — always `execFile` with an argv array.
- `MAESTRO_ENABLED` defaults to `false`; Chekku boots normally without Maestro installed.
- Do not weaken existing security boundaries or disable existing tests.
- Code style: NO comments unless the step explicitly includes one.

---

## File Structure

**New (agent):**
- `agent/src/mastra/maestro/paths.ts` — memoized absolute-path resolution for workspace/artifact dir.
- `agent/src/mastra/maestro/flow-path.ts` — pure flow-path resolver (containment + regular-file).
- `agent/src/mastra/maestro/run-flow.ts` — safe `execFile` runner + JUnit/artifact capture.
- `agent/src/mastra/maestro/mcp-client.ts` — lazy env-gated MCPClient factory + allowlist filter.
- `agent/src/agents/qa-android-agent.ts` — agent + `shouldApproveQaAndroidTool` classifier.
- `agent/src/mastra/tools/run-maestro-flow.ts` — curated tool wrapping the runner.

**New (repo root):**
- `maestro/smoke/launch.yaml` — example flow.

**Modified (agent):** `config/env.ts`, `config/env.test.ts`, `agents/context.ts`, `mastra/index.ts`.

**Modified (client):** `lib/types.ts`, `lib/agents-helpers.ts`, `lib/agents-helpers.test.ts`, `components/agents/agent-catalog-page.tsx`, `components/chat/chat-studio.tsx`, `lib/ui-structure.test.ts`.

**Modified (docs/config):** `.gitignore`, `.env.example`, `agent/.env.example`, `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `AGENTS.md`.

---

## Task 1: Add Maestro environment variables

**Files:**
- Modify: `agent/src/config/env.ts`
- Modify: `agent/src/config/env.test.ts`

**Interfaces:**
- Produces: `env.MAESTRO_ENABLED` (`'true'|'false'`), `env.MAESTRO_COMMAND` (string), `env.MAESTRO_WORKSPACE` (string), `env.MAESTRO_ARTIFACT_DIR` (string), `env.MAESTRO_TIMEOUT_MS` (number).

- [ ] **Step 1: Write the failing test**

Append to `agent/src/config/env.test.ts`, inside the existing top-level `describe('env config', ...)` block, a new `it`:

```ts
  it('applies Maestro defaults (disabled by default)', () => {
    const value = loadEnv({});

    expect(value.MAESTRO_ENABLED).toBe('false');
    expect(value.MAESTRO_COMMAND).toBe('maestro');
    expect(value.MAESTRO_WORKSPACE).toBe('../maestro');
    expect(value.MAESTRO_ARTIFACT_DIR).toBe('../artifacts/maestro');
    expect(value.MAESTRO_TIMEOUT_MS).toBe(120000);
  });

  it('accepts Maestro overrides and rejects invalid enabled flags', () => {
    const value = loadEnv({
      MAESTRO_ENABLED: 'true',
      MAESTRO_COMMAND: '/usr/local/bin/maestro',
      MAESTRO_WORKSPACE: '/abs/maestro',
      MAESTRO_ARTIFACT_DIR: '/abs/artifacts/maestro',
      MAESTRO_TIMEOUT_MS: '60000',
    });

    expect(value.MAESTRO_ENABLED).toBe('true');
    expect(value.MAESTRO_COMMAND).toBe('/usr/local/bin/maestro');
    expect(value.MAESTRO_TIMEOUT_MS).toBe(60000);

    expect(() => loadEnv({ MAESTRO_ENABLED: 'yes' })).toThrow();
    expect(() => loadEnv({ MAESTRO_TIMEOUT_MS: '0' })).toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/config/env.test.ts`
Expected: FAIL — `value.MAESTRO_ENABLED` is `undefined`.

- [ ] **Step 3: Implement the schema fields**

In `agent/src/config/env.ts`, add these five fields to the `envSchema` object, after the `BROWSER_HEADLESS` line and before the `GARAGE_ENDPOINT` line:

```ts
  MAESTRO_ENABLED: z.enum(['true', 'false']).default('false'),
  MAESTRO_COMMAND: z.string().default('maestro'),
  MAESTRO_WORKSPACE: z.string().default('../maestro'),
  MAESTRO_ARTIFACT_DIR: z.string().default('../artifacts/maestro'),
  MAESTRO_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/config/env.ts agent/src/config/env.test.ts
git commit -m "feat(agent): add Maestro environment configuration"
```

---

## Task 2: Add `mobileAccess` request-context field

**Files:**
- Modify: `agent/src/agents/context.ts`

**Interfaces:**
- Produces: `providerContextSchema` now also accepts `mobileAccess: 'approval'|'full'`; `ProviderContext` type extended. Consumed by Task 8/9.

- [ ] **Step 1: Write the failing test**

Create `agent/src/agents/__tests__/context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { providerContextSchema } from '../context.js';

describe('providerContextSchema', () => {
  it('accepts browserAccess and mobileAccess independently', () => {
    const parsed = providerContextSchema.parse({
      browserAccess: 'full',
      mobileAccess: 'approval',
    });

    expect(parsed.browserAccess).toBe('full');
    expect(parsed.mobileAccess).toBe('approval');
  });

  it('makes both access modes optional and rejects unknown values', () => {
    expect(providerContextSchema.parse({}).browserAccess).toBeUndefined();
    expect(providerContextSchema.parse({}).mobileAccess).toBeUndefined();

    expect(() => providerContextSchema.parse({ mobileAccess: 'yes' })).toThrow();
    expect(() => providerContextSchema.parse({ browserAccess: 'always' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/agents/__tests__/context.test.ts`
Expected: FAIL — `mobileAccess` not in schema (`undefined !== 'approval'`).

- [ ] **Step 3: Add the field**

Replace the contents of `agent/src/agents/context.ts` with:

```ts
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';

export const providerContextSchema = z.object({
  browserAccess: z.enum(['approval', 'full']).optional(),
  mobileAccess: z.enum(['approval', 'full']).optional(),
});

export type ProviderContext = z.infer<typeof providerContextSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/agents/__tests__/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/agents/context.ts agent/src/agents/__tests__/context.test.ts
git commit -m "feat(agent): add mobileAccess request-context field"
```

---

## Task 3: Absolute-path resolution for workspace and artifact dirs

**Files:**
- Create: `agent/src/mastra/maestro/paths.ts`
- Create: `agent/src/mastra/maestro/__tests__/paths.test.ts`

**Interfaces:**
- Produces: `resolveWorkspaceAbs(from)` and `resolveArtifactDirAbs(from)` — return absolute paths, memoized per input. Used by Tasks 4, 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/maestro/__tests__/paths.test.ts`:

```ts
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAbsolutePath, resetPathCache, cacheSize } from '../paths.js';

describe('resolveAbsolutePath', () => {
  it('resolves a relative path against the base to an absolute path', () => {
    resetPathCache();
    const abs = resolveAbsolutePath('/repo/agent', '../maestro');

    expect(isAbsolute(abs)).toBe(true);
    expect(abs.includes('repo')).toBe(true);
    expect(abs.endsWith('maestro')).toBe(true);
  });

  it('returns absolute inputs unchanged in normalized form', () => {
    resetPathCache();
    const input = process.platform === 'win32' ? 'C:\\abs\\maestro' : '/abs/maestro';
    expect(resolveAbsolutePath('/anywhere', input)).toBe(input);
  });

  it('memoizes the result for the same input', () => {
    resetPathCache();
    const a = resolveAbsolutePath('/repo/agent', '../maestro');
    const b = resolveAbsolutePath('/repo/agent', '../maestro');

    expect(a).toBe(b);
    expect(cacheSize()).toBe(1);
  });
});
```

> **Cross-platform note:** `path.resolve('/repo/agent', '../maestro')` on Windows prepends the
> current drive (e.g. `C:\repo\maestro`), so the test asserts `isAbsolute` + suffix + `repo`
> segment rather than an exact string.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `agent/src/mastra/maestro/paths.ts`:

```ts
import { resolve } from 'node:path';

const cache = new Map<string, string>();

export function resolveAbsolutePath(base: string, input: string): string {
  const key = `${base}\0${input}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const resolved = resolve(base, input);
  cache.set(key, resolved);
  return resolved;
}

export function resetPathCache(): void {
  cache.clear();
}

export function cacheSize(): number {
  return cache.size;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/maestro/paths.ts agent/src/mastra/maestro/__tests__/paths.test.ts
git commit -m "feat(agent): add memoized absolute path resolution for Maestro dirs"
```

---

## Task 4: Flow-path resolver (security-critical)

**Files:**
- Create: `agent/src/mastra/maestro/flow-path.ts`
- Create: `agent/src/mastra/maestro/__tests__/flow-path.test.ts`

**Interfaces:**
- Consumes: `resolveAbsolutePath` from Task 3 (the caller passes an already-absolute `workspaceAbs`).
- Produces: `resolveMaestroFlowPath({ suite, flow }, deps)` → `{ absolutePath }` or throws. Uses injectable `deps: { realpath, stat }` for testability. Used by Task 5 and Task 6.

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/maestro/__tests__/flow-path.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/flow-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `agent/src/mastra/maestro/flow-path.ts`:

```ts
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
```

> **Containment rationale:** `path.relative(a, b)` returns `''` when `a === b`, a path starting
> with `..` when `b` is outside `a` on the same drive/root, and a plain relative path when `b` is
> inside `a`. On Windows, when `a` and `b` are on **different drives**, `relative` returns an
> absolute path (e.g. `D:\secret`) with no `..` prefix — so the guard also rejects
> `isAbsolute(rel)`. The three terms together catch same-path, same-root-escape, and cross-drive
> escape on every platform.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/flow-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/maestro/flow-path.ts agent/src/mastra/maestro/__tests__/flow-path.test.ts
git commit -m "feat(agent): add validated Maestro flow-path resolver"
```

---

## Task 5: Safe flow runner (execFile + JUnit + timeout + bounded output)

**Files:**
- Create: `agent/src/mastra/maestro/run-flow.ts`
- Create: `agent/src/mastra/maestro/__tests__/run-flow.test.ts`

**Interfaces:**
- Consumes: `resolveMaestroFlowPath` (Task 4).
- Produces: `runMaestroFlow(input, options)` → `RunFlowResult`. Injectable `exec` and `now`/`fs` seams for testing. Used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/maestro/__tests__/run-flow.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/run-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `agent/src/mastra/maestro/run-flow.ts`:

```ts
import { join, relative } from 'node:path';

import { resolveMaestroFlowPath } from './flow-path.js';

export const MAX_OUTPUT_CHARS = 65_536;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecFn {
  (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; cwd: string }): Promise<ExecResult>;
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
```

> **Why two budgets:** the capture budget passed to `execFile` (`MAX_OUTPUT_CHARS * 16` ≈ 1MB) is
> intentionally larger than the return budget (`MAX_OUTPUT_CHARS` ≈ 64K chars). Without this, a
> suite logging >64KB trips `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` before `boundOutput` ever runs,
> making `runMaestroFlow` reject and defeating the Failed/Blocked mapping. `boundOutput` remains
> the real bound on what the model sees. `MAX_OUTPUT_CHARS` is named for what it measures (UTF-16
> code units / chars), since token cost tracks chars better than bytes for model output.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/run-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/maestro/run-flow.ts agent/src/mastra/maestro/__tests__/run-flow.test.ts
git commit -m "feat(agent): add safe Maestro flow runner with JUnit output"
```

---

## Task 6: Curated `run_maestro_flow` tool

**Files:**
- Create: `agent/src/mastra/tools/run-maestro-flow.ts`
- Create: `agent/src/mastra/tools/run-maestro-flow.test.ts`

**Interfaces:**
- Consumes: `runMaestroFlow` (Task 5), `resolveAbsolutePath` (Task 3), `env` (Task 1).
- Produces: `runMaestroFlowTool` (a Mastra `ToolAction` registered on the agent). Injectable factory `createRunMaestroFlowTool(options)` for testing. By default resolves `env.MAESTRO_WORKSPACE` / `env.MAESTRO_ARTIFACT_DIR` to absolute paths once via `resolveAbsolutePath`.

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/tools/run-maestro-flow.test.ts`:

```ts
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
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never);

    expect(output.result).toBe('Passed');
    expect(output.runId).toBe('20260717000000_deadbeef');
    expect(output.relativeRunDir).toBe('20260717000000_deadbeef');
    expect(output.junitPath).toBe('20260717000000_deadbeef/junit.xml');
  });

  it('returns Blocked when disabled', async () => {
    const tool = createRunMaestroFlowTool({ enabled: false });
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never);

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
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never);

    expect(output.result).toBe('Blocked');
    expect(output.message).not.toContain(secret);
    expect(output.message).toMatch(/could not run|workspace/i);
  });

  it('surfaces the safe resolver message when the flow file is missing', async () => {
    const tool = makeTool({
      stat: async () => ({ isFile: () => false, isDirectory: () => false }),
    });
    const output = await tool.execute!({ suite: 'smoke', flow: 'login' }, {} as never);

    expect(output.result).toBe('Blocked');
    expect(output.message).toMatch(/not a regular file/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/tools/run-maestro-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `agent/src/mastra/tools/run-maestro-flow.ts`:

```ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { env } from '../../config/env.js';
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
  return new Promise((resolve) => {
    execFile(file, args as string[], opts, (err, stdout, stderr) => {
      const signal = (err as NodeJS.ErrnoException | null)?.signal;
      const timedOut = signal === 'SIGTERM';
      const numericExit = typeof (err as { code?: unknown } | null)?.code === 'number'
        ? (err as { code: number }).code
        : 1;
      resolve({
        code: err ? (timedOut ? null : numericExit) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut,
      });
    });
  });
};

export const runMaestroFlowTool = createRunMaestroFlowTool({
  enabled: env.MAESTRO_ENABLED === 'true',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/tools/run-maestro-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/tools/run-maestro-flow.ts agent/src/mastra/tools/run-maestro-flow.test.ts
git commit -m "feat(agent): add curated run_maestro_flow tool"
```

---

## Task 7: Maestro MCP client factory + allowlist filter

**Files:**
- Create: `agent/src/mastra/maestro/mcp-client.ts`
- Create: `agent/src/mastra/maestro/__tests__/mcp-client.test.ts`

**Interfaces:**
- Produces: `MAESTRO_TOOL_ALLOWLIST` (readonly logical names), `filterMaestroTools(tools)` (pure), `createMaestroMcpClient(options)` (lazy MCPClient), `loadMaestroMcpTools()` (memoized, degrades to `{}` on failure/disabled). Used by Task 9.

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/maestro/__tests__/mcp-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MAESTRO_TOOL_ALLOWLIST, filterMaestroTools, namespacedAllowlist, sanitizeMaestroEnv } from '../mcp-client.js';

describe('Maestro MCP allowlist', () => {
  it('exposes the documented read-only, granular, and run_flow tools', () => {
    expect(MAESTRO_TOOL_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'list_devices',
        'inspect_view_hierarchy',
        'take_screenshot',
        'check_syntax',
        'cheat_sheet',
        'query_docs',
        'tap_on',
        'input_text',
        'back',
        'launch_app',
        'stop_app',
        'start_device',
        'run_flow',
      ]),
    );
    expect(MAESTRO_TOOL_ALLOWLIST).not.toContain('run_flow_files');
  });

  it('namespaces every allowlisted tool with the maestro_ prefix', () => {
    expect(namespacedAllowlist()).toContain('maestro_list_devices');
    expect(namespacedAllowlist()).toContain('maestro_run_flow');
  });

  it('keeps only allowlisted tools and drops run_flow_files + unknown tools', () => {
    const tools = {
      maestro_list_devices: { id: 'list_devices' },
      maestro_run_flow: { id: 'run_flow' },
      maestro_run_flow_files: { id: 'run_flow_files' },
      maestro_run_on_cloud: { id: 'run_on_cloud' },
      maestro_secret_thing: { id: 'secret' },
    };

    const filtered = filterMaestroTools(tools);
    expect(Object.keys(filtered).sort()).toEqual(['maestro_list_devices', 'maestro_run_flow']);
  });

  it('sanitizeMaestroEnv keeps only PATH/HOME/Android/Java vars and drops all secrets', () => {
    const env = sanitizeMaestroEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANDROID_HOME: '/android/sdk',
      JAVA_HOME: '/java',
      LLM_API_KEY: 'secret-llm',
      GARAGE_SECRET_ACCESS_KEY: 'secret-garage',
      RESEND_API_KEY: 'secret-resend',
      TELEGRAM_BOT_TOKEN: 'secret-tg',
      RANDOM_UNUSED: 'ignored',
    } as NodeJS.ProcessEnv);

    expect(Object.keys(env).sort()).toEqual(['ANDROID_HOME', 'HOME', 'JAVA_HOME', 'PATH']);
    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('LLM_API_KEY');
    expect(env).not.toHaveProperty('GARAGE_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/mcp-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `agent/src/mastra/maestro/mcp-client.ts`:

```ts
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';

export const MAESTRO_MCP_SERVER_NAME = 'maestro';

export const MAESTRO_TOOL_ALLOWLIST = [
  'list_devices',
  'inspect_view_hierarchy',
  'take_screenshot',
  'check_syntax',
  'cheat_sheet',
  'query_docs',
  'tap_on',
  'input_text',
  'back',
  'launch_app',
  'stop_app',
  'start_device',
  'run_flow',
] as const;

export function namespacedAllowlist(): readonly string[] {
  return MAESTRO_TOOL_ALLOWLIST.map((name) => `${MAESTRO_MCP_SERVER_NAME}_${name}`);
}

const ALLOWED_KEYS = new Set<string>(namespacedAllowlist());

export function filterMaestroTools<T extends Record<string, unknown>>(tools: T): Record<string, T[string]> {
  const result: Record<string, T[string]> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (ALLOWED_KEYS.has(key)) result[key] = value as T[string];
  }
  return result;
}

export const MAESTRO_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'JAVA_HOME',
] as const;

export function sanitizeMaestroEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MAESTRO_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

export interface CreateMaestroMcpClientOptions {
  command: string;
  timeoutMs: number;
}

export function createMaestroMcpClient(options: CreateMaestroMcpClientOptions): MCPClient {
  const server: MastraMCPServerDefinition = {
    command: options.command,
    args: ['mcp'],
    env: sanitizeMaestroEnv(),
  };
  return new MCPClient({
    servers: { [MAESTRO_MCP_SERVER_NAME]: server },
    timeout: options.timeoutMs,
  });
}
```

> **Why `env` is set:** providing `env` to a stdio MCP server *replaces* (not merges) the parent
> process environment. Without it, the spawned `maestro` subprocess would inherit
> `LLM_API_KEY`, `GARAGE_SECRET_ACCESS_KEY`, `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc. — a
> secret-leak surface for any tool the subprocess exposes. `sanitizeMaestroEnv` keeps only what
> Maestro/adb/Java need to run (PATH, HOME/USERPROFILE, ANDROID_*, JAVA_HOME).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/maestro/__tests__/mcp-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/maestro/mcp-client.ts agent/src/mastra/maestro/__tests__/mcp-client.test.ts
git commit -m "feat(agent): add allowlisted Maestro MCP client factory"
```

---

## Task 8 + 9: `qa-android-agent` (classifier + agent wiring)

**Files:**
- Create: `agent/src/agents/qa-android-agent.ts`
- Create: `agent/src/agents/__tests__/qa-android-agent.test.ts`

**Interfaces:**
- Consumes: `getServerModel`, `Memory`, `gatewayCompatibilityProcessor`, `calculatorTool`, `getCurrentTimeTool`, `runMaestroFlowTool` (Task 6), `loadMaestroMcpTools` (Task 7), `providerContextSchema` (Task 2), `env` (Task 1).
- Produces: `qaAndroidAgent` and pure `shouldApproveQaAndroidTool(mobileAccess, toolName)`. Registered in Task 10.

- [ ] **Step 1: Write the failing test**

Create `agent/src/agents/__tests__/qa-android-agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { shouldApproveQaAndroidTool } from '../qa-android-agent.js';

describe('shouldApproveQaAndroidTool', () => {
  describe('read-only Maestro tools (never approved)', () => {
    for (const tool of [
      'maestro_list_devices',
      'maestro_inspect_view_hierarchy',
      'maestro_take_screenshot',
      'maestro_check_syntax',
      'maestro_cheat_sheet',
      'maestro_query_docs',
    ]) {
      it(`${tool} runs without approval in any mode`, () => {
        expect(shouldApproveQaAndroidTool('approval', tool)).toBe(false);
        expect(shouldApproveQaAndroidTool('full', tool)).toBe(false);
        expect(shouldApproveQaAndroidTool(undefined, tool)).toBe(false);
      });
    }
  });

  describe('granular interaction tools (respect mobileAccess)', () => {
    for (const tool of [
      'maestro_tap_on',
      'maestro_input_text',
      'maestro_back',
      'maestro_launch_app',
      'maestro_stop_app',
      'maestro_start_device',
    ]) {
      it(`${tool} is gated in approval mode and free in full mode`, () => {
        expect(shouldApproveQaAndroidTool('approval', tool)).toBe(true);
        expect(shouldApproveQaAndroidTool('full', tool)).toBe(false);
        expect(shouldApproveQaAndroidTool(undefined, tool)).toBe(true);
      });
    }
  });

  it('always requires approval for maestro_run_flow (inline/generated YAML)', () => {
    expect(shouldApproveQaAndroidTool('approval', 'maestro_run_flow')).toBe(true);
    expect(shouldApproveQaAndroidTool('full', 'maestro_run_flow')).toBe(true);
    expect(shouldApproveQaAndroidTool(undefined, 'maestro_run_flow')).toBe(true);
  });

  it('gates run_maestro_flow (checked-in) by mobileAccess', () => {
    expect(shouldApproveQaAndroidTool('approval', 'run_maestro_flow')).toBe(true);
    expect(shouldApproveQaAndroidTool('full', 'run_maestro_flow')).toBe(false);
    expect(shouldApproveQaAndroidTool(undefined, 'run_maestro_flow')).toBe(true);
  });

  it('never gates harmless tools (calculator, getCurrentTime)', () => {
    expect(shouldApproveQaAndroidTool('approval', 'calculator')).toBe(false);
    expect(shouldApproveQaAndroidTool('full', 'getCurrentTime')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/agents/__tests__/qa-android-agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the agent**

Create `agent/src/agents/qa-android-agent.ts`:

```ts
import { Agent, type AgentConfig, type ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import type { Tool } from '@mastra/core/tools';

import { gatewayCompatibilityProcessor } from '../mastra/processors/gateway-compatibility.js';
import { filterMaestroTools, createMaestroMcpClient } from '../mastra/maestro/mcp-client.js';
import { calculatorTool } from '../mastra/tools/calculator.js';
import { getCurrentTimeTool } from '../mastra/tools/get-current-time.js';
import { runMaestroFlowTool } from '../mastra/tools/run-maestro-flow.js';
import { getServerModel } from '../providers/model.js';
import { providerContextSchema, type ProviderContext } from './context.js';
import { env } from '../config/env.js';

const READ_ONLY_TOOLS = new Set([
  'maestro_list_devices',
  'maestro_inspect_view_hierarchy',
  'maestro_take_screenshot',
  'maestro_check_syntax',
  'maestro_cheat_sheet',
  'maestro_query_docs',
]);

const GRANULAR_TOOLS = new Set([
  'maestro_tap_on',
  'maestro_input_text',
  'maestro_back',
  'maestro_launch_app',
  'maestro_stop_app',
  'maestro_start_device',
]);

const ALWAYS_APPROVE_TOOLS = new Set(['maestro_run_flow']);

const MODE_GATED_TOOLS = new Set<string>([...GRANULAR_TOOLS, 'run_maestro_flow']);

export function shouldApproveQaAndroidTool(mobileAccess: unknown, toolName: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (ALWAYS_APPROVE_TOOLS.has(toolName)) return true;
  if (MODE_GATED_TOOLS.has(toolName)) return mobileAccess !== 'full';
  return false;
}

let maestroClient: ReturnType<typeof createMaestroMcpClient> | undefined;
let cachedMaestroTools: ToolsInput | undefined;

async function loadMaestroMcpTools(): Promise<ToolsInput> {
  if (env.MAESTRO_ENABLED !== 'true') return {};
  if (cachedMaestroTools) return cachedMaestroTools;
  try {
    maestroClient ??= createMaestroMcpClient({
      command: env.MAESTRO_COMMAND,
      timeoutMs: env.MAESTRO_TIMEOUT_MS,
    });
    const all = (await maestroClient.listTools()) as Record<string, Tool>;
    cachedMaestroTools = filterMaestroTools(all);
    return cachedMaestroTools;
  } catch {
    return {};
  }
}

const instructions = `You are QA Android Agent, a careful mobile QA delegate that drives Android applications through Maestro.

Complete the assigned Android QA task, then return distilled findings, evidence, and blockers. Use Maestro tools only when live device interaction is required. Do not greet or add progress narration.

Before purchases, sending messages, account deletion, password changes, clearing application data, publishing, or any other consequential action, clearly describe the action and request approval. Never expose secrets or credentials. If no device or application is available, or authentication is required, state that plainly as a blocker.

Always respond using exactly this Markdown structure:

Summary
- Result: Passed / Failed / Blocked
- App ID
- Device
- Scenario

Executed scenarios
1. Scenario — Result

Findings
- ID
- Severity
- Expected behaviour
- Actual behaviour
- Reproduction steps
- Evidence

Blockers
- Missing device, missing application, authentication requirement, or infrastructure problem

Never claim a test Passed unless Maestro completed successfully. If Maestro is not enabled or no device is reachable, report Result as Blocked.`;

const qaAndroidAgentConfig: AgentConfig<string, ToolsInput, undefined, ProviderContext> = {
  id: 'qa-android-agent',
  name: 'QA Android Agent',
  description:
    'Completes Android application QA through Maestro, then returns concise findings, evidence, reproduction steps, and blockers. Use when a task requires interacting with an Android emulator or device.',
  model: () => getServerModel(),
  requestContextSchema: providerContextSchema,
  inputProcessors: [gatewayCompatibilityProcessor],
  memory: new Memory(),
  tools: async () => ({
    ...(await loadMaestroMcpTools()),
    run_maestro_flow: runMaestroFlowTool,
    calculatorTool,
    getCurrentTimeTool,
  }),
  defaultOptions: ({ requestContext }) => ({
    maxSteps: 80,
    requireToolApproval: ({ toolName }) =>
      shouldApproveQaAndroidTool(requestContext.get('mobileAccess'), toolName),
  }),
  instructions,
};

export const qaAndroidAgent = new Agent(qaAndroidAgentConfig);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/agents/__tests__/qa-android-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/agents/qa-android-agent.ts agent/src/agents/__tests__/qa-android-agent.test.ts
git commit -m "feat(agent): add qa-android-agent with Maestro approval gating"
```

---

## Task 10: Register the agent + guard existing agents

**Files:**
- Modify: `agent/src/mastra/index.ts`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Consumes: `qaAndroidAgent` (Task 9).

- [ ] **Step 1: Write the failing test**

In `agent/src/agents/__tests__/both-agents.test.ts`, add imports and a new describe block. First add to the imports at the top:

```ts
import { qaAndroidAgent } from '../qa-android-agent.js';
```

Then append at the end of the file:

```ts
describe('qa-android-agent (Maestro Android QA)', () => {
  it('has id qa-android-agent and name QA Android Agent', () => {
    expect(qaAndroidAgent.id).toBe('qa-android-agent');
    expect(qaAndroidAgent.name).toBe('QA Android Agent');
  });

  it('has Mastra memory', async () => {
    expect(await qaAndroidAgent.getMemory()).toBeDefined();
  });

  it('binds run_maestro_flow, calculator, and current-time tools', async () => {
    const tools = await qaAndroidAgent.listTools();
    expect(Object.keys(tools).sort()).toEqual(
      expect.arrayContaining(['calculatorTool', 'getCurrentTimeTool', 'run_maestro_flow']),
    );
  });
});

describe('agent differentiation (all five agents)', () => {
  it('has mutually distinct ids', () => {
    const ids = [mainAgent.id, pmAgent.id, qaWebAgent.id, qaAndroidAgent.id];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/agents/__tests__/both-agents.test.ts`
Expected: FAIL — `qaAndroidAgent` is not exported from index / not imported.

- [ ] **Step 3: Register the agent**

In `agent/src/mastra/index.ts`:

Add to the agent imports (after the `qaWebAgent` import line):

```ts
import { qaAndroidAgent } from '../agents/qa-android-agent.js';
```

Change the `agents:` line in the `Mastra` constructor from:

```ts
  agents: { mainAgent, pmAgent, qaWebAgent, socialMediaAgent },
```

to:

```ts
  agents: { mainAgent, pmAgent, qaWebAgent, qaAndroidAgent, socialMediaAgent },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/agents/__tests__/both-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/index.ts agent/src/agents/__tests__/both-agents.test.ts
git commit -m "feat(agent): register qa-android-agent in the Mastra composition root"
```

---

## Task 11: Example smoke flow

**Files:**
- Create: `maestro/smoke/launch.yaml`

- [ ] **Step 1: Create the file**

Create `maestro/smoke/launch.yaml`:

```yaml
# Placeholder app id. Replace with your application's package before running.
appId: com.example.qaapp
---
- launchApp
```

- [ ] **Step 2: Commit**

```bash
git add maestro/smoke/launch.yaml
git commit -m "feat(maestro): add example smoke launch flow"
```

---

## Task 12: Client reserved id + helpers

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/agents-helpers.ts`
- Modify: `client/src/lib/agents-helpers.test.ts`

**Interfaces:**
- Produces: `QA_ANDROID_AGENT_ID` constant in `types.ts`; `RESERVED_AGENT_IDS` includes it in both `types.ts` and `agents-helpers.ts`. Consumed by Tasks 13 and 14.

- [ ] **Step 1: Write the failing test**

In `client/src/lib/agents-helpers.test.ts`, add to the existing `'rejects missing, malformed, reserved, and duplicate IDs'` `it` block, after the `qa-web-agent`/`pm-agent` assertions:

```ts
    expect(validateAgentId('qa-android-agent', new Set())).toBe('reserved');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/agents-helpers.test.ts`
Expected: FAIL — `qa-android-agent` is not reserved (returns `null`).

- [ ] **Step 3: Update `types.ts`**

In `client/src/lib/types.ts`, replace the reserved-id block:

```ts
export const MAIN_AGENT_ID = 'main-agent';
export const QA_WEB_AGENT_ID = 'qa-web-agent';
export const QA_ANDROID_AGENT_ID = 'qa-android-agent';
export const PM_AGENT_ID = 'pm-agent';
export const RESERVED_AGENT_IDS = new Set<string>([
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  QA_ANDROID_AGENT_ID,
  PM_AGENT_ID,
]);
```

- [ ] **Step 4: Update `agents-helpers.ts`**

In `client/src/lib/agents-helpers.ts`, replace the `RESERVED_AGENT_IDS` definition:

```ts
export const RESERVED_AGENT_IDS = new Set<string>([
  'main-agent',
  'qa-web-agent',
  'qa-android-agent',
  'pm-agent',
]);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run client/src/lib/agents-helpers.test.ts client/src/lib/ui-structure.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/agents-helpers.ts client/src/lib/agents-helpers.test.ts
git commit -m "feat(client): reserve qa-android-agent id"
```

---

## Task 13: Catalog badge for the Android agent

**Files:**
- Modify: `client/src/components/agents/agent-catalog-page.tsx`
- Modify: `client/src/lib/ui-structure.test.ts`

**Interfaces:**
- Produces: the catalog renders `qa-android-agent` with a distinct `▷` glyph and an `Android Agent` badge.

- [ ] **Step 1: Write the failing test**

In `client/src/lib/ui-structure.test.ts`, add a new `it` inside the `describe('requested UI structure', ...)` block. Also add a catalog source reader near the other `readFileSync` declarations at the top of the file (after the `chatStudio` declaration):

```ts
const agentCatalogSource = readFileSync(
  new URL('../components/agents/agent-catalog-page.tsx', import.meta.url),
  'utf8',
);
```

Then the test (catalog glyph only — the chat-studio badge is asserted in Task 14):

```ts
  it('renders an Android glyph for qa-android-agent in the catalog', () => {
    expect(agentCatalogSource).toContain("agent.id === 'qa-android-agent' ? '▷'");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: FAIL — `'Android Agent'` not found in chat-studio, and the catalog glyph check fails.

- [ ] **Step 3: Update the catalog glyph**

In `client/src/components/agents/agent-catalog-page.tsx`, replace the glyph `<span>` line:

```tsx
                      <span className="studio-agent-glyph">
                        {agent.id === 'qa-web-agent' ? '◎' : '◇'}
                      </span>
```

with:

```tsx
                      <span className="studio-agent-glyph">
                        {agent.id === 'qa-web-agent'
                          ? '◎'
                          : agent.id === 'qa-android-agent'
                            ? '▷'
                            : '◇'}
                      </span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: PASS (catalog glyph assertion).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/agents/agent-catalog-page.tsx client/src/lib/ui-structure.test.ts
git commit -m "feat(client): show Android agent glyph in the catalog"
```

---

## Task 14: Chat access switch (mobileAccess vs browserAccess)

**Files:**
- Modify: `client/src/components/chat/chat-studio.tsx`
- Modify: `client/src/lib/ui-structure.test.ts`

**Interfaces:**
- Produces: the Ask First / Full Access switch appears only for the two QA agents; sends `mobileAccess` for `qa-android-agent` and `browserAccess` for `qa-web-agent`; hidden otherwise; two separate persisted localStorage keys.

- [ ] **Step 1: Write the failing test**

In `client/src/lib/ui-structure.test.ts`, add an `it` inside `describe('requested UI structure', ...)`:

```ts
  it('gates the access switch to QA agents and sends mobileAccess for android', () => {
    expect(chatStudio).toContain('Android Agent');
    expect(chatStudio).toContain("QA_WEB_AGENT_ID || agentId === QA_ANDROID_AGENT_ID");
    expect(chatStudio).toContain("'chekku-mobile-access'");
    expect(chatStudio).toContain("context.set('mobileAccess', mobileMode)");
    expect(chatStudio).toContain("context.set('browserAccess', browserMode)");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: FAIL — strings not present.

- [ ] **Step 3: Update `chat-studio.tsx`**

In `client/src/components/chat/chat-studio.tsx`:

3a. Add `QA_ANDROID_AGENT_ID` to the type import. Replace:

```tsx
import {
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolEvent,
} from '@/lib/types';
```

with:

```tsx
import {
  MAIN_AGENT_ID,
  QA_WEB_AGENT_ID,
  QA_ANDROID_AGENT_ID,
  type ChatMessage,
  type ChekkuAgentSummary,
  type ToolEvent,
} from '@/lib/types';
```

3b. Replace the single access-mode constant and state. Change:

```tsx
const ACCESS_MODE_KEY = 'chekku-browser-access';
```

to:

```tsx
const BROWSER_ACCESS_KEY = 'chekku-browser-access';
const MOBILE_ACCESS_KEY = 'chekku-mobile-access';
```

3c. Replace the single `accessMode` state declaration:

```tsx
  const [accessMode, setAccessMode] = useState<'approval' | 'full'>(
    'approval',
  );
```

with two states:

```tsx
  const [browserMode, setBrowserMode] = useState<'approval' | 'full'>('approval');
  const [mobileMode, setMobileMode] = useState<'approval' | 'full'>('approval');
```

3d. Replace the `requestContext` callback:

```tsx
  const requestContext = useCallback(() => {
    const context = new RequestContext();
    context.set('browserAccess', accessMode);
    return context;
  }, [accessMode]);
```

with:

```tsx
  const isQaAgent = agentId === QA_WEB_AGENT_ID || agentId === QA_ANDROID_AGENT_ID;
  const accessMode = agentId === QA_ANDROID_AGENT_ID ? mobileMode : browserMode;
  const setAccessMode = agentId === QA_ANDROID_AGENT_ID ? setMobileMode : setBrowserMode;

  const requestContext = useCallback(() => {
    const context = new RequestContext();
    context.set('browserAccess', browserMode);
    context.set('mobileAccess', mobileMode);
    return context;
  }, [browserMode, mobileMode]);
```

3e. Replace both `useEffect` blocks that reference `ACCESS_MODE_KEY` and `accessMode`. Change:

```tsx
  useEffect(() => {
    const saved = window.localStorage.getItem(ACCESS_MODE_KEY);
    if (saved !== 'full') return;

    const frame = window.requestAnimationFrame(() => {
      setAccessMode('full');
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(ACCESS_MODE_KEY, accessMode);
  }, [accessMode]);
```

to:

```tsx
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (window.localStorage.getItem(BROWSER_ACCESS_KEY) === 'full') setBrowserMode('full');
      if (window.localStorage.getItem(MOBILE_ACCESS_KEY) === 'full') setMobileMode('full');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(BROWSER_ACCESS_KEY, browserMode);
  }, [browserMode]);

  useEffect(() => {
    window.localStorage.setItem(MOBILE_ACCESS_KEY, mobileMode);
  }, [mobileMode]);
```

3f. Wrap the badge and switch so they only render for QA agents. Replace the `<div className="chat-topbar-actions">` block:

```tsx
          <div className="chat-topbar-actions">
            {agentId === QA_WEB_AGENT_ID && (
              <span className="chat-browser-badge">◎ Browser agent</span>
            )}
            <button
              className={`chat-access-switch ${
                accessMode === 'full' ? 'full' : ''
              }`}
              type="button"
              role="switch"
              aria-checked={accessMode === 'full'}
              onClick={() =>
                setAccessMode((current) =>
                  current === 'approval' ? 'full' : 'approval',
                )
              }
              disabled={isStreaming}
            >
              <span>
                <i />
              </span>
              {accessMode === 'full' ? 'Full access' : 'Ask first'}
            </button>
          </div>
```

with:

```tsx
          <div className="chat-topbar-actions">
            {agentId === QA_WEB_AGENT_ID && (
              <span className="chat-browser-badge">◎ Browser agent</span>
            )}
            {agentId === QA_ANDROID_AGENT_ID && (
              <span className="chat-browser-badge">▷ Android Agent</span>
            )}
            {isQaAgent && (
              <button
                className={`chat-access-switch ${
                  accessMode === 'full' ? 'full' : ''
                }`}
                type="button"
                role="switch"
                aria-checked={accessMode === 'full'}
                onClick={() =>
                  setAccessMode((current) =>
                    current === 'approval' ? 'full' : 'approval',
                  )
                }
                disabled={isStreaming}
              >
                <span>
                  <i />
                </span>
                {accessMode === 'full' ? 'Full access' : 'Ask first'}
              </button>
            )}
          </div>
```

3g. Replace the two remaining `accessMode` references in the composer footer. Change:

```tsx
                {agentId === QA_WEB_AGENT_ID && (
                  <span className="chat-memory-chip">◎ Browser</span>
                )}
```

to:

```tsx
                {agentId === QA_WEB_AGENT_ID && (
                  <span className="chat-memory-chip">◎ Browser</span>
                )}
                {agentId === QA_ANDROID_AGENT_ID && (
                  <span className="chat-memory-chip">▷ Maestro</span>
                )}
```

And change the closing `<p>` line:

```tsx
          <p className={accessMode === 'full' ? 'warning' : ''}>
            {accessMode === 'full'
              ? 'Full access is active. Browser actions run without approval.'
              : 'Ask first is active. Consequential browser actions require approval.'}
          </p>
```

to:

```tsx
          <p className={accessMode === 'full' ? 'warning' : ''}>
            {!isQaAgent
              ? ''
              : accessMode === 'full'
                ? agentId === QA_ANDROID_AGENT_ID
                  ? 'Full access is active. Checked-in Maestro flows and granular actions run without approval.'
                  : 'Full access is active. Browser actions run without approval.'
                : agentId === QA_ANDROID_AGENT_ID
                  ? 'Ask first is active. Maestro interactions and checked-in flows require approval.'
                  : 'Ask first is active. Consequential browser actions require approval.'}
          </p>
```

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`
Expected: PASS.

Run: `npm run lint --workspace client`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/chat/chat-studio.tsx client/src/lib/ui-structure.test.ts
git commit -m "feat(client): gate access switch to QA agents and send mobileAccess"
```

---

## Task 15: `.gitignore` + env examples

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `agent/.env.example`

- [ ] **Step 1: Update `.gitignore`**

In `.gitignore`, add under the `# Test and browser artifacts` section (after `*.log`):

```
artifacts/
```

- [ ] **Step 2: Update `.env.example`**

In `.env.example`, add after the `BROWSER_HEADLESS=true` line:

```dotenv
# QA Android Agent (Maestro). Disabled by default; requires the Maestro CLI, ADB, and an emulator/device.
MAESTRO_ENABLED=false
MAESTRO_COMMAND=maestro
MAESTRO_WORKSPACE=../maestro
MAESTRO_ARTIFACT_DIR=../artifacts/maestro
MAESTRO_TIMEOUT_MS=120000
```

- [ ] **Step 3: Update `agent/.env.example`**

In `agent/.env.example`, add after the `BROWSER_HEADLESS=true` line:

```dotenv
# QA Android Agent (Maestro). Disabled by default; requires the Maestro CLI, ADB, and an emulator/device.
MAESTRO_ENABLED=false
MAESTRO_COMMAND=maestro
MAESTRO_WORKSPACE=../maestro
MAESTRO_ARTIFACT_DIR=../artifacts/maestro
MAESTRO_TIMEOUT_MS=120000
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.example agent/.env.example
git commit -m "chore: add Maestro env examples and ignore artifacts"
```

---

## Task 16: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `AGENTS.md`

For each file, add a focused Maestro section mirroring the existing Telegram/Garage prose style. Do not restate the whole architecture.

- [ ] **Step 1: `README.md`**

1a. Add a bullet to the **Highlights** list (after the Browser QA bullet):

```markdown
- **Android QA agent** — drive Android apps through Maestro on a local emulator or device with allowlisted tools and approval-gated flows.
```

1b. Add `qa-android-agent` to the architecture diagram's agent list (after `qa-web-agent`).

1c. Add a row block to the **Agent server** env table:

```markdown
| `MAESTRO_ENABLED` | No | `false` | Enable the QA Android Agent's Maestro integration. |
| `MAESTRO_COMMAND` | No | `maestro` | Maestro CLI binary. |
| `MAESTRO_WORKSPACE` | No | `../maestro` | Directory holding `smoke/`, `regression/`, `shared/` flows (relative to the agent cwd). |
| `MAESTRO_ARTIFACT_DIR` | No | `../artifacts/maestro` | Where run reports/screenshots are written. |
| `MAESTRO_TIMEOUT_MS` | No | `120000` | Per-flow timeout in milliseconds. |
```

1d. Add an **Optional integrations** bullet:

```markdown
- **Android QA (qa-android-agent)** — install the [Maestro CLI](https://maestro.mobile.dev/) and ADB, start an emulator or connect a device, then set `MAESTRO_ENABLED=true`. Chekku, Maestro, ADB, and the device must run on the same machine.
```

- [ ] **Step 2: `docs/ARCHITECTURE.md`**

2a. Add `qa-android-agent` to the agent list in the diagram and the composition-root bullet list.

2b. Add a new `### QA Android Agent` subsection after the `### QA Web Agent` subsection:

```markdown
### QA Android Agent

`qa-android-agent` is the mobile counterpart to `qa-web-agent`. It shares the common server model, Mastra Memory, and gateway compatibility processor. A trusted, env-gated `MCPClient` connects to the local `maestro mcp` server over stdio and exposes only an explicit allowlist of Maestro tools (`list_devices`, `inspect_view_hierarchy`, `take_screenshot`, `check_syntax`, `cheat_sheet`, `query_docs`, `tap_on`, `input_text`, `back`, `launch_app`, `stop_app`, `start_device`, `run_flow`). `run_flow_files` and any cloud tools are never exposed.

Approval is decided by a single pure classifier driven by the `mobileAccess` request-context field (separate from `browserAccess`): read-only tools never require approval; granular interactions and the curated `run_maestro_flow` runner honour the access mode; `maestro_run_flow` (inline/generated YAML) always requires approval.

The curated `run_maestro_flow` tool resolves logical `{ suite, flow }` names to checked-in YAML under `MAESTRO_WORKSPACE`, validates real-path containment after symlink resolution, confirms a regular file, and runs via `execFile` (never a shell string) with `--format junit --output` and `--test-output-dir` writing into `artifacts/maestro/<runId>/`. It never reports Passed unless Maestro exits 0.

Maestro is disabled by default; the agent and server boot normally without it.
```

- [ ] **Step 3: `docs/OPERATIONS.md`**

Add a new `## Android QA (qa-android-agent)` section after the `## Browser operation` section:

```markdown
## Android QA (qa-android-agent)

```dotenv
MAESTRO_ENABLED=false
MAESTRO_COMMAND=maestro
MAESTRO_WORKSPACE=../maestro
MAESTRO_ARTIFACT_DIR=../artifacts/maestro
MAESTRO_TIMEOUT_MS=120000
```

Chekku, the Maestro CLI, ADB, and an Android emulator or physical device must be reachable on the same machine. Confirm with `adb devices` before enabling.

`MAESTRO_ENABLED` defaults to `false`; the server boots normally without Maestro installed. Set it to `true` only on a machine with Maestro, ADB, and a device.

The agent exposes an allowlisted subset of `maestro mcp` tools. `run_flow_files` and cloud tools are never attached. Read-only tools (device listing, hierarchy inspection, screenshots, syntax check, cheat sheet, docs query) run without approval. Granular interactions (`tap_on`, `input_text`, `back`, `launch_app`, `stop_app`, `start_device`) and the curated `run_maestro_flow` runner honour the Ask First / Full Access switch (`mobileAccess`). `maestro_run_flow` with inline or generated YAML always requires approval.

`run_maestro_flow` accepts logical names only (`{ suite: 'smoke', flow: 'login' }`), resolves them under `MAESTRO_WORKSPACE`, rejects traversal/absolute paths/backslashes, and writes JUnit reports and artifacts to `MAESTRO_ARTIFACT_DIR/<runId>/`. It never reports Passed unless Maestro exits 0.

Common failures:

- **Maestro MCP reports missing tools / connection refused** — confirm `maestro mcp` starts manually and `MAESTRO_ENABLED=true` after restart.
- **No device** — the agent returns a Blocked result; start an emulator or connect a device and re-run.
- **Flow not found** — confirm the logical name maps to `<workspace>/<suite>/<flow>.yaml` and that the file is a regular file inside the workspace.
```

- [ ] **Step 4: `AGENTS.md`**

In `AGENTS.md`, add a new `### QA Android Agent` subsection under `## Architecture invariants` (after the `### QA Web Agent` subsection):

```markdown
### QA Android Agent

- Keep `qa-android-agent` code-defined with Mastra Memory and the gateway compatibility processor.
- Bind a trusted, env-gated `MCPClient` to `maestro mcp` privately on this agent only; do not add it to the global `mcpServers` (which stays fixed to `garage`).
- Expose only the explicit Maestro tool allowlist; never expose `run_flow_files` or any cloud tool. Never auto-attach every tool from `listTools()`.
- Keep `mobileAccess: 'approval' | 'full'` separate from `browserAccess`; never reuse browser access for mobile.
- Approval: read-only tools never gated; granular interactions and `run_maestro_flow` honour `mobileAccess`; `maestro_run_flow` (inline/generated YAML) always gated.
- The curated flow runner accepts logical `{ suite, flow }` names only; reject absolute paths, `..`, backslashes, caller-supplied extensions, and non-regular files; resolve real-path containment after symlinks.
- Run flows via `execFile` with an argv array (never a shell string), `--format junit --output` and `--test-output-dir` into `artifacts/maestro/<runId>/`, with `MAESTRO_TIMEOUT_MS`, bounded output, and child cleanup.
- Never report a test Passed unless Maestro exited 0.
- `MAESTRO_ENABLED` defaults to `false`; the server boots normally without Maestro.
```

- [ ] **Step 5: Run full check + build**

Run: `npm run check`
Expected: PASS (typecheck + lint + all tests).

Run: `npm run build`
Expected: PASS.

Run: `git -C C:\dev\chekku diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ARCHITECTURE.md docs/OPERATIONS.md AGENTS.md
git commit -m "docs: document the QA Android Agent and Maestro integration"
```

---

## Manual Acceptance (required before PR)

Per spec §14, after all tasks pass automated checks, verify on a real emulator/device:

1. `maestro`, `adb`, and a device are reachable (`adb devices` lists one).
2. `MAESTRO_ENABLED=true` set in `agent/.env`; agent restarted.
3. `qa-android-agent` appears in the catalog with the `▷` glyph.
4. `maestro_list_devices` runs without approval and lists the device.
5. Ask First: a granular action requests approval; Full Access: it does not; `maestro_run_flow` requests approval in both modes.
6. `run_maestro_flow` with `{ suite: 'smoke', flow: 'launch' }` runs, writes `artifacts/maestro/<runId>/junit.xml`, returns Passed/Failed consistent with the run.
7. Final response follows the Summary/Findings/Blockers contract; never claims Passed unless Maestro succeeded.
8. `{ suite: '../secret', flow: 'x' }` (and backslash/absolute variants) rejected before spawn.

Record device, app id, and per-step pass/fail in the PR description.
