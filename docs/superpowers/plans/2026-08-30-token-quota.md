# Per-User Daily Token Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-user (`resourceId`) token usage per UTC day on the agent server and block new runs with a fixed 429 when the daily limit is reached.

**Architecture:** A new in-memory `TokenQuotaStore` (`agent/src/mastra/runs/token-quota.ts`, same philosophy as the run registry) accumulates consumed tokens per `resourceId` per UTC day. `runExecution` records usage from the currently-discarded `step-finish`/`finish` stream chunks through a `RunUsageTracker`. `startRunRoute` gates new runs with `assertQuota` after agent resolution, before thread creation.

**Tech Stack:** TypeScript strict, zod (env), Vitest, Mastra `fullStream` chunk payloads (`totalUsage`, `output.usage` — AI SDK `LanguageModelUsage` shape: `{ inputTokens, outputTokens, totalTokens, ... }`).

**Spec:** `docs/superpowers/specs/2026-08-30-token-quota-design.md`

## Global Constraints

- `TOKEN_DAILY_LIMIT`: integer ≥ 0, default `500000`, `0` = unlimited. Server-only; never exposed to browser code.
- Quota error surfaces as HTTP 429 with the exact fixed message: `Daily token limit reached (<used> of <limit> tokens used). Resets at midnight UTC.` (figures `toLocaleString('en-US')`-formatted).
- Enforcement order in `startRunRoute`: parse (400) → resolveAgent (404) → **assertQuota (429)** → ensureFirstTurnThread → createRun (409/429).
- Counters are in-memory, single-instance, process lifetime. No SQL, no Garage, no new dependencies.
- Not metered, not gated: scheduled workflows (`weekly-social-drafts`, `repurpose-social-post`, `generate-social-post-visual`), the image-generation model, image-generation tool internals.
- Usage recording never emits run events (no client-visible changes; `chunkToRunEvent` keeps ignoring the usage chunk types).
- Node `>=22.22.0`; commands run from repo root; tests via `npx vitest run <path>`; final gate `npm run check` and `npm run build` (both with `NODE_OPTIONS=--max-old-space-size=8192` if heap runs out).
- Windows host: shell is PowerShell; `rg` is unavailable — use the Grep/Glob tools, not bash `rg`/`head`.
- Commit style: conventional commits (`feat:`, `test:`, `docs:`), never commit secrets.

---

### Task 1: `TOKEN_DAILY_LIMIT` env var

**Files:**
- Modify: `agent/src/config/env.ts` (schema, after the `CHEKKU_DEFAULT_AGENT_ID` line)
- Modify: `agent/.env.example` (after the `BROWSER_HEADLESS=true` line)
- Test: `agent/src/config/env.test.ts` (append describe block)

**Interfaces:**
- Consumes: existing `envSchema` / `loadEnv` in `agent/src/config/env.ts`.
- Produces: `env.TOKEN_DAILY_LIMIT: number` for Task 5's singleton.

- [ ] **Step 1: Write the failing test**

Append to `agent/src/config/env.test.ts` (match the file's existing `loadEnv(source)` style — it calls `loadEnv` with a plain object of overrides; copy the minimal-keys pattern an existing test in that file uses, e.g. the `LLM_DEFAULT_MODEL` test at line ~67):

```ts
describe('TOKEN_DAILY_LIMIT', () => {
  it('defaults to 500000 when unset', () => {
    expect(loadEnv({}).TOKEN_DAILY_LIMIT).toBe(500_000);
  });

  it('coerces numeric strings and accepts zero (unlimited)', () => {
    expect(loadEnv({ TOKEN_DAILY_LIMIT: '250000' }).TOKEN_DAILY_LIMIT).toBe(
      250_000,
    );
    expect(loadEnv({ TOKEN_DAILY_LIMIT: '0' }).TOKEN_DAILY_LIMIT).toBe(0);
  });

  it('rejects negative and non-integer values', () => {
    expect(() => loadEnv({ TOKEN_DAILY_LIMIT: '-1' })).toThrow();
    expect(() => loadEnv({ TOKEN_DAILY_LIMIT: '1.5' })).toThrow();
  });
});
```

Note: check the top of `env.test.ts` first — if `loadEnv` there passes a full env object, add only the key you need; the schema has defaults for everything else, so `{}` / single-key objects parse fine.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/config/env.test.ts`
Expected: FAIL — `TOKEN_DAILY_LIMIT` missing from parsed env (undefined ≠ 500000).

- [ ] **Step 3: Write minimal implementation**

In `agent/src/config/env.ts`, inside `envSchema`, after the `CHEKKU_DEFAULT_AGENT_ID: z.string().default('main-agent'),` line add:

```ts
  // Per-user daily token quota (input + output tokens summed per resourceId
  // per UTC day) enforced at run start. 0 disables enforcement. Counters are
  // in-memory; an agent server restart gives users a fresh daily quota.
  TOKEN_DAILY_LIMIT: z.coerce.number().int().min(0).default(500_000),
```

In `agent/.env.example`, after the `BROWSER_HEADLESS=true` line add:

```
# Per-user daily token quota across all agents (input + output tokens summed
# per user per UTC day). 0 disables enforcement. Counters are in-memory:
# an agent server restart gives users a fresh daily quota.
TOKEN_DAILY_LIMIT=500000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/config/env.test.ts`
Expected: PASS (all tests in the file, not just the new block).

- [ ] **Step 5: Commit**

```bash
git add agent/src/config/env.ts agent/src/config/env.test.ts agent/.env.example
git commit -m "feat: add TOKEN_DAILY_LIMIT env var for per-user token quota"
```

---

### Task 2: `TokenQuotaStore` + `TokenQuotaExceededError`

**Files:**
- Create: `agent/src/mastra/runs/token-quota.ts`
- Test: `agent/src/mastra/runs/token-quota.test.ts`

**Interfaces:**
- Consumes: nothing yet (the `tokenQuotaStore` singleton at the bottom imports `env` from Task 1).
- Produces (used by Tasks 3–5):
  - `class TokenQuotaExceededError extends Error` with `readonly used: number; readonly limit: number;`
  - `function quotaExceededMessage(used: number, limit: number): string`
  - `interface TokenQuotaConsumer { consume(resourceId: string, tokens: number): void }`
  - `class TokenQuotaStore` with `constructor(options?: { limit?: number; now?: () => number })`, `getUsage(resourceId): { used: number; limit: number }`, `consume(resourceId, tokens): void`, `assertQuota(resourceId): void`
  - `const tokenQuotaStore: TokenQuotaStore` (module singleton)

- [ ] **Step 1: Write the failing test**

Create `agent/src/mastra/runs/token-quota.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TokenQuotaExceededError,
  TokenQuotaStore,
  quotaExceededMessage,
} from './token-quota.js';

const DAY_1_NOON = Date.UTC(2026, 7, 30, 12, 0, 0); // 2026-08-30
const DAY_2_NOON = Date.UTC(2026, 7, 31, 12, 0, 0); // 2026-08-31

function fixedStore(limit: number, at: number = DAY_1_NOON) {
  let now = at;
  const store = new TokenQuotaStore({ limit, now: () => now });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('quotaExceededMessage', () => {
  it('formats the fixed bounded message', () => {
    expect(quotaExceededMessage(500_000, 500_000)).toBe(
      'Daily token limit reached (500,000 of 500,000 tokens used). Resets at midnight UTC.',
    );
    expect(quotaExceededMessage(12_345, 10_000)).toBe(
      'Daily token limit reached (12,345 of 10,000 tokens used). Resets at midnight UTC.',
    );
  });
});

describe('TokenQuotaStore', () => {
  it('accumulates usage per resource independently', () => {
    const { store } = fixedStore(1000);
    store.consume('user-1', 100);
    store.consume('user-1', 50);
    store.consume('user-2', 30);
    expect(store.getUsage('user-1')).toEqual({ used: 150, limit: 1000 });
    expect(store.getUsage('user-2')).toEqual({ used: 30, limit: 1000 });
  });

  it('ignores non-positive or non-finite consumption', () => {
    const { store } = fixedStore(1000);
    store.consume('user-1', 0);
    store.consume('user-1', -5);
    store.consume('user-1', Number.NaN);
    expect(store.getUsage('user-1').used).toBe(0);
  });

  it('assertQuota passes below the limit and throws at the boundary', () => {
    const { store } = fixedStore(100);
    store.consume('user-1', 99);
    expect(() => store.assertQuota('user-1')).not.toThrow();
    store.consume('user-1', 1);
    expect(() => store.assertQuota('user-1')).toThrow(TokenQuotaExceededError);
    try {
      store.assertQuota('user-1');
    } catch (error) {
      const quotaError = error as TokenQuotaExceededError;
      expect(quotaError.used).toBe(100);
      expect(quotaError.limit).toBe(100);
      expect(quotaError.message).toBe(quotaExceededMessage(100, 100));
    }
  });

  it('resets lazily when the UTC day changes', () => {
    const { store, advance } = fixedStore(100);
    store.consume('user-1', 100);
    expect(() => store.assertQuota('user-1')).toThrow();
    advance(DAY_2_NOON - DAY_1_NOON);
    expect(store.getUsage('user-1')).toEqual({ used: 0, limit: 100 });
    expect(() => store.assertQuota('user-1')).not.toThrow();
  });

  it('enforces no quota when limit is 0', () => {
    const { store } = fixedStore(0);
    store.consume('user-1', Number.MAX_SAFE_INTEGER);
    expect(() => store.assertQuota('user-1')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/runs/token-quota.test.ts`
Expected: FAIL — cannot resolve `./token-quota.js`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/src/mastra/runs/token-quota.ts`:

```ts
/**
 * In-memory per-user daily token quota.
 *
 * Same philosophy as the run registry: the agent server is single-instance,
 * so counters live in the process and die with it (a restart gives every
 * user a fresh daily quota). No SQL, no Garage — durability was rejected in
 * the design (see docs/superpowers/specs/2026-08-30-token-quota-design.md).
 * The public surface stays narrow so a durable store can replace the Map
 * without touching call sites.
 */

import { env } from '../../config/env.js';

/** Fixed bounded message; surfaced as HTTP 429 without diagnostics. */
export function quotaExceededMessage(used: number, limit: number): string {
  return `Daily token limit reached (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens used). Resets at midnight UTC.`;
}

export class TokenQuotaExceededError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(quotaExceededMessage(used, limit));
    this.name = 'TokenQuotaExceededError';
    this.used = used;
    this.limit = limit;
  }
}

/** Structural subset of TokenQuotaStore consumed by the run execution loop. */
export interface TokenQuotaConsumer {
  consume(resourceId: string, tokens: number): void;
}

export interface TokenQuotaStoreOptions {
  /** Daily token budget per resourceId; 0 disables enforcement. */
  limit?: number;
  /** Injectable epoch-ms clock, mirroring RunRegistryOptions.now. */
  now?: () => number;
}

interface QuotaEntry {
  /** UTC day as YYYY-MM-DD. */
  day: string;
  used: number;
}

export class TokenQuotaStore implements TokenQuotaConsumer {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, QuotaEntry>();

  constructor(options: TokenQuotaStoreOptions = {}) {
    this.limit = Math.max(0, Math.floor(options.limit ?? 0));
    this.now = options.now ?? Date.now;
  }

  private currentDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private entry(resourceId: string): QuotaEntry {
    const day = this.currentDay();
    const existing = this.entries.get(resourceId);
    if (!existing || existing.day !== day) {
      // Lazy day rollover: a stale entry from a previous UTC day resets to 0.
      const fresh: QuotaEntry = { day, used: 0 };
      this.entries.set(resourceId, fresh);
      return fresh;
    }
    return existing;
  }

  getUsage(resourceId: string): { used: number; limit: number } {
    return { used: this.entry(resourceId).used, limit: this.limit };
  }

  consume(resourceId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.entry(resourceId).used += Math.floor(tokens);
  }

  assertQuota(resourceId: string): void {
    if (this.limit <= 0) return;
    const { used } = this.entry(resourceId);
    if (used >= this.limit) throw new TokenQuotaExceededError(used, this.limit);
  }
}

/** Server-wide singleton; process lifetime, single-instance invariant. */
export const tokenQuotaStore = new TokenQuotaStore({
  limit: env.TOKEN_DAILY_LIMIT,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/runs/token-quota.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/runs/token-quota.ts agent/src/mastra/runs/token-quota.test.ts
git commit -m "feat: add in-memory per-user daily TokenQuotaStore"
```

---

### Task 3: `RunUsageTracker`

**Files:**
- Modify: `agent/src/mastra/runs/token-quota.ts` (append tracker)
- Test: `agent/src/mastra/runs/token-quota.test.ts` (append describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `class RunUsageTracker` with `constructor(consume: (tokens: number) => void)`, `recordStepFinish(payload: Record<string, unknown>): void`, `recordFinish(payload: Record<string, unknown>): void`, `get consumed(): number`. One instance per run; consumes only growth deltas.

- [ ] **Step 1: Write the failing test**

Append to `agent/src/mastra/runs/token-quota.test.ts`:

```ts
import { RunUsageTracker } from './token-quota.js'; // add to the existing import

describe('RunUsageTracker', () => {
  function trackerOf() {
    const consumed: number[] = [];
    const tracker = new RunUsageTracker((tokens) => consumed.push(tokens));
    return { tracker, consumed };
  }

  it('consumes cumulative step-finish totalUsage as deltas', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({ totalUsage: { totalTokens: 100 } });
    tracker.recordStepFinish({ totalUsage: { totalTokens: 250 } });
    tracker.recordStepFinish({ totalUsage: { totalTokens: 250 } });
    expect(consumed).toEqual([100, 150]);
    expect(tracker.consumed).toBe(250);
  });

  it('ignores non-monotonic step reports (per-step reporting variants)', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({ totalUsage: { totalTokens: 200 } });
    tracker.recordStepFinish({ totalUsage: { totalTokens: 50 } });
    expect(consumed).toEqual([200]);
  });

  it('falls back to inputTokens + outputTokens when totalTokens is absent', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({
      totalUsage: { inputTokens: 700, outputTokens: 300 },
    });
    expect(consumed).toEqual([1000]);
  });

  it('reconciles the finish whole-run total, consuming only the shortfall', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({ totalUsage: { totalTokens: 100 } });
    tracker.recordFinish({ output: { usage: { totalTokens: 400 } } });
    tracker.recordFinish({ output: { usage: { totalTokens: 300 } } });
    expect(consumed).toEqual([100, 300]);
    expect(tracker.consumed).toBe(400);
  });

  it('consumes everything at finish when steps reported no usage', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordFinish({
      output: { usage: { inputTokens: 60, outputTokens: 40 } },
    });
    expect(consumed).toEqual([100]);
  });

  it('is a no-op for malformed payloads', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({});
    tracker.recordStepFinish({ totalUsage: null });
    tracker.recordStepFinish({ totalUsage: { totalTokens: 'lots' } });
    tracker.recordFinish({});
    tracker.recordFinish({ output: {} });
    tracker.recordFinish({ output: { usage: undefined } });
    expect(consumed).toEqual([]);
    expect(tracker.consumed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/runs/token-quota.test.ts`
Expected: FAIL — `RunUsageTracker` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `agent/src/mastra/runs/token-quota.ts` (above the `tokenQuotaStore` singleton at the bottom):

```ts
type UnknownRecord = Record<string, unknown>;

/** Reads an AI SDK LanguageModelUsage-shaped value into a token total. */
function usageTotalTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as UnknownRecord;
  const total = record.totalTokens;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    return Math.floor(total);
  }
  const input = record.inputTokens;
  const output = record.outputTokens;
  if (
    typeof input === 'number' &&
    Number.isFinite(input) &&
    input >= 0 &&
    typeof output === 'number' &&
    Number.isFinite(output) &&
    output >= 0
  ) {
    return Math.floor(input + output);
  }
  return null;
}

/**
 * Records one run's token usage into a quota consumer, delta-only so nothing
 * is double-counted. Mastra's `step-finish` payload carries `totalUsage` —
 * cumulative usage across steps so far (AI SDK contract) — so each event
 * consumes only growth over the highest cumulative total seen. A gateway
 * variant that reports non-cumulatively (or not at all) is caught by
 * `recordFinish`, which reconciles against the whole-run total in
 * `output.usage` and consumes only the shortfall.
 */
export class RunUsageTracker {
  private readonly consume: (tokens: number) => void;
  private highestStepTotal = 0;
  private recorded = 0;

  constructor(consume: (tokens: number) => void) {
    this.consume = consume;
  }

  recordStepFinish(payload: UnknownRecord): void {
    const total = usageTotalTokens(payload.totalUsage);
    if (total === null || total <= this.highestStepTotal) return;
    const delta = total - this.highestStepTotal;
    this.highestStepTotal = total;
    this.recorded += delta;
    this.consume(delta);
  }

  recordFinish(payload: UnknownRecord): void {
    const output = payload.output;
    const usage =
      output && typeof output === 'object'
        ? (output as UnknownRecord).usage
        : undefined;
    const total = usageTotalTokens(usage);
    if (total === null || total <= this.recorded) return;
    const delta = total - this.recorded;
    this.recorded = total;
    this.consume(delta);
  }

  get consumed(): number {
    return this.recorded;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/runs/token-quota.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/runs/token-quota.ts agent/src/mastra/runs/token-quota.test.ts
git commit -m "feat: add RunUsageTracker for delta-only stream usage recording"
```

---

### Task 4: Record usage in `runExecution`

**Files:**
- Modify: `agent/src/mastra/runs/execute.ts` (import, signature, stream loop at lines 237–246)
- Test: `agent/src/mastra/runs/execute.test.ts` (append describe block)

**Interfaces:**
- Consumes: `RunUsageTracker`, `TokenQuotaConsumer` from Task 2/3.
- Produces: `runExecution(registry, agent, params, quota?: TokenQuotaConsumer)` — optional 4th parameter; existing call sites (Task 5's route) pass `tokenQuotaStore`; existing tests without it are unaffected.

- [ ] **Step 1: Write the failing test**

Append to `agent/src/mastra/runs/execute.test.ts`:

```ts
describe('runExecution token usage recording', () => {
  function quotaSpy() {
    const calls: Array<{ resourceId: string; tokens: number }> = [];
    const quota = {
      consume: (resourceId: string, tokens: number) => {
        calls.push({ resourceId, tokens });
      },
    };
    return { quota, calls };
  }

  it('consumes step deltas and the finish reconciliation against the quota', async () => {
    const registry = new RunRegistry();
    const { memory } = makeMemory(true);
    const { agent } = makeAgent(
      [
        { type: 'text-delta', payload: { text: 'hi' } },
        { type: 'step-finish', payload: { totalUsage: { totalTokens: 120 } } },
        { type: 'step-finish', payload: { totalUsage: { totalTokens: 300 } } },
        {
          type: 'finish',
          payload: { output: { usage: { totalTokens: 350 } } },
        },
      ],
      memory,
    );
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'spend tokens',
      requestAbort: () => undefined,
    });
    const { quota, calls } = quotaSpy();

    await runExecution(registry, agent, {
      runId: run.id,
      ...TUPLE,
      prompt: 'spend tokens',
      abortSignal: new AbortController().signal,
    }, quota);

    // Deltas 120 + 180 from steps, then the 50-token finish shortfall.
    expect(calls).toEqual([
      { resourceId: TUPLE.resourceId, tokens: 120 },
      { resourceId: TUPLE.resourceId, tokens: 180 },
      { resourceId: TUPLE.resourceId, tokens: 50 },
    ]);
    expect(registry.getRun(run.id)?.status).toBe('completed');
  });

  it('keeps consumption when the stream fails mid-run', async () => {
    const registry = new RunRegistry();
    const failing: RunnableAgent = {
      stream: async () => ({
        fullStream: new ReadableStream<Chunk>({
          start(controller) {
            controller.enqueue({
              type: 'step-finish',
              payload: { totalUsage: { totalTokens: 90 } },
            });
            controller.error(new Error('gateway dropped'));
          },
        }),
      }),
      getMemory: async () => undefined,
    };
    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'boom mid-stream',
      requestAbort: () => undefined,
    });
    const { quota, calls } = quotaSpy();

    await runExecution(registry, failing, {
      runId: run.id,
      ...TUPLE,
      prompt: 'boom mid-stream',
      abortSignal: new AbortController().signal,
    }, quota);

    expect(calls).toEqual([
      { resourceId: TUPLE.resourceId, tokens: 90 },
    ]);
    expect(registry.getRun(run.id)?.status).toBe('failed');
  });

  it('runs without a quota consumer and emits no usage events either way', async () => {
    const registry = new RunRegistry();
    const { agent } = makeAgent([
      { type: 'step-finish', payload: { totalUsage: { totalTokens: 10 } } },
      { type: 'finish', payload: { output: { usage: { totalTokens: 10 } } } },
    ]);

    const run = registry.createRun({
      id: createRunId(),
      ...TUPLE,
      prompt: 'no quota',
      requestAbort: () => undefined,
    });

    await expect(
      runExecution(registry, agent, {
        runId: run.id,
        ...TUPLE,
        prompt: 'no quota',
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    const events: string[] = [];
    registry.subscribeFrom(run.id, 0, (event) => events.push(event.type));
    expect(events).toEqual(['finish']); // usage chunks never become events
  });
});
```

Note: `Chunk` is the local type alias already defined at the top of `execute.test.ts` (`type Chunk = { type?: unknown; payload?: unknown }`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/runs/execute.test.ts`
Expected: FAIL — first two tests fail: `runExecution` ignores the 4th argument, `calls` is `[]`.

- [ ] **Step 3: Write minimal implementation**

In `agent/src/mastra/runs/execute.ts`:

1. Add import after the existing `./run-registry.js` import:

```ts
import {
  RunUsageTracker,
  type TokenQuotaConsumer,
} from './token-quota.js';
```

2. Change the `runExecution` signature and stream loop. Replace:

```ts
export async function runExecution(
  registry: RunRegistry,
  agent: RunnableAgent,
  params: RunExecutionParams,
): Promise<void> {
  let sawError = false;
```

with:

```ts
export async function runExecution(
  registry: RunRegistry,
  agent: RunnableAgent,
  params: RunExecutionParams,
  quota?: TokenQuotaConsumer,
): Promise<void> {
  let sawError = false;
  const usageTracker = new RunUsageTracker((tokens) =>
    quota?.consume(params.resourceId, tokens),
  );
```

3. In the stream loop, replace:

```ts
      const mapped = chunkToRunEvent(value ?? {});
```

with:

```ts
      const chunk = value ?? {};
      // Usage chunks feed the token quota only; they never become run
      // events, so the client stream is unchanged.
      if (chunk.type === 'step-finish') {
        usageTracker.recordStepFinish(chunkPayload(chunk));
      } else if (chunk.type === 'finish') {
        usageTracker.recordFinish(chunkPayload(chunk));
      }
      const mapped = chunkToRunEvent(chunk);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/runs/execute.test.ts`
Expected: PASS (entire file — the pre-existing tests must still pass unchanged).

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/runs/execute.ts agent/src/mastra/runs/execute.test.ts
git commit -m "feat: record per-run token usage from step-finish/finish chunks"
```

---

### Task 5: Enforce quota in `startRunRoute`

**Files:**
- Modify: `agent/src/mastra/routes/runs.ts` (import + handler block at lines ~211–220)
- Test: `agent/src/mastra/routes/runs.test.ts` (extend the module mock at the top + append tests)

**Interfaces:**
- Consumes: `tokenQuotaStore`, `TokenQuotaExceededError` from Task 2; `runExecution`'s new 4th parameter from Task 4.
- Produces: HTTP 429 `{ error }` on exhausted quota; `runExecution` call now passes the singleton.

- [ ] **Step 1: Write the failing test**

In `agent/src/mastra/routes/runs.test.ts`:

1. Extend the mock block at the top. After the existing `registryState` / `vi.mock('../runs/run-registry.js', ...)` block and before `beforeEach`, add:

```ts
// Same pattern as the registry: swap the module-level tokenQuotaStore
// singleton per test so handler-level tests control quota state.
const quotaState = vi.hoisted(() => ({
  store: undefined as unknown as {
    assertQuota: (resourceId: string) => void;
    consume: (resourceId: string, tokens: number) => void;
  },
}));

vi.mock('../runs/token-quota.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../runs/token-quota.js')>();
  return {
    ...actual,
    get tokenQuotaStore() {
      return quotaState.store;
    },
  };
});
```

2. Extend `beforeEach` (replace the existing body):

```ts
beforeEach(() => {
  registryState.registry = new RunRegistry();
  quotaState.store = {
    assertQuota: () => undefined,
    consume: () => undefined,
  };
});
```

3. Add `TokenQuotaExceededError` to the import from `'../runs/run-registry.js'`? No — it lives in token-quota. Add a new import at the top:

```ts
import { TokenQuotaExceededError } from '../runs/token-quota.js';
```

4. Append the describe block (uses the file's existing `startHandler`, `makeContext`, `runnableAgent`, `VALID`, `seedRunningRun` helpers):

```ts
describe('run routes: token quota gate', () => {
  function blockedQuota() {
    quotaState.store = {
      assertQuota: () => {
        throw new TokenQuotaExceededError(500_000, 500_000);
      },
      consume: () => undefined,
    };
  }

  function mastraWithAgent() {
    return {
      getAgentById: (id: string) => (id === 'main-agent' ? runnableAgent : undefined),
    };
  }

  it('returns 429 with the fixed message when the quota is exhausted', async () => {
    blockedQuota();
    const res = await startHandler(
      makeContext({ body: { ...VALID }, mastra: mastraWithAgent() }) as never,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error:
        'Daily token limit reached (500,000 of 500,000 tokens used). Resets at midnight UTC.',
    });
  });

  it('blocks before creating a thread record or a run', async () => {
    blockedQuota();
    const memoryCalls: string[] = [];
    const agentWithMemory = {
      stream: runnableAgent.stream,
      getMemory: async () => ({
        getThreadById: async () => {
          memoryCalls.push('getThreadById');
          return null;
        },
        createThread: async () => {
          memoryCalls.push('createThread');
          return {};
        },
      }),
    };
    const res = await startHandler(
      makeContext({
        body: { ...VALID },
        mastra: { getAgentById: () => agentWithMemory },
      }) as never,
    );
    expect(res.status).toBe(429);
    expect(memoryCalls).toEqual([]); // ensureFirstTurnThread never ran
    expect(registryState.registry.findActiveRun(
      'main-agent',
      'main-agent-user-1-uuid-a',
      'user-1',
    )).toBeNull();
  });

  it('still returns 404 for an unknown agent when the quota is exhausted', async () => {
    blockedQuota();
    const res = await startHandler(
      makeContext({
        body: { ...VALID },
        mastra: { getAgentById: () => undefined },
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  it('starts normally while under the quota', async () => {
    const res = await startHandler(
      makeContext({ body: { ...VALID }, mastra: mastraWithAgent() }) as never,
    );
    expect(res.status).toBe(202);
  });
});
```

Note: `findActiveRun` is used in later route tests already — confirm its exact name in the file (`agentRunRegistry.findActiveRun(agentId, threadId, resourceId)` appears in the route source). If the test file's `registryState.registry` type does not expose it, call it through the same shape the other handler tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/routes/runs.test.ts`
Expected: FAIL — the 429 tests get 202 (no quota check in the handler yet). The mock itself compiles: `importOriginal` of token-quota returns the real module (its `tokenQuotaStore` getter is overridden).

- [ ] **Step 3: Write minimal implementation**

In `agent/src/mastra/routes/runs.ts`:

1. Add import after the `./execute.js` import block:

```ts
import { TokenQuotaExceededError, tokenQuotaStore } from '../runs/token-quota.js';
```

2. In `startRunRoute`'s handler, after the `resolveAgent` 404 block and before the `ensureFirstTurnThread` comment block, insert:

```ts
    // Token quota gate: a blocked user gets a fixed 429 before any thread
    // record or run registry state is created. The limit is the global
    // server default (TOKEN_DAILY_LIMIT); counters are in-memory and die
    // with the process, so a restart gives the user a fresh daily quota.
    try {
      tokenQuotaStore.assertQuota(resourceId);
    } catch (error) {
      if (error instanceof TokenQuotaExceededError) {
        return c.json({ error: error.message }, 429);
      }
      throw error;
    }
```

3. Pass the quota into execution — change the `runExecution` call to add the 4th argument:

```ts
    void runExecution(
      agentRunRegistry,
      agent,
      {
        runId,
        agentId,
        threadId,
        resourceId,
        prompt,
        ...(content ? { content } : {}),
        abortSignal: controller.signal,
      },
      tokenQuotaStore,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/routes/runs.test.ts`
Expected: PASS (entire file, including all pre-existing handler tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/routes/runs.ts agent/src/mastra/routes/runs.test.ts
git commit -m "feat: gate run starts on the per-user daily token quota (429)"
```

---

### Task 6: Docs + full verification

**Files:**
- Modify: `README.md` (agent env table, after the `LLM_IMAGE_ENDPOINT_PATH` row at line ~134)
- Modify: `AGENTS.md` ("Agent run lifecycle" section, new bullet after the concurrency-caps bullet; plus the run-lifecycle entry in the Testing rules list)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: documentation matching the shipped behavior.

- [ ] **Step 1: README env table**

After the `| \`LLM_IMAGE_ENDPOINT_PATH\` | ... |` row in the "Agent server" table, add:

```markdown
| `TOKEN_DAILY_LIMIT` | No | `500000` | Per-user daily token quota across all agents (input + output summed per user per UTC day). `0` disables. Counters are in-memory: an agent restart resets them, and the quota resets at midnight UTC. Blocked prompts get a 429 with a fixed message. |
```

- [ ] **Step 2: AGENTS.md run-lifecycle bullet**

In the "Agent run lifecycle" section of `AGENTS.md`, after the bullet that starts "Concurrent running runs are capped" (the one describing 4-per-`resourceId` / 64 global caps and the watchdog), add:

```markdown
- Per-user daily token quota: `TOKEN_DAILY_LIMIT` (integer ≥ 0, default 500,000, `0` = unlimited) caps summed input+output tokens per `resourceId` per UTC day. `startRunRoute` checks `tokenQuotaStore.assertQuota` after agent resolution and before `ensureFirstTurnThread`/`createRun` (fixed 429 message, no diagnostics). Usage is recorded inside `runExecution` from `step-finish`/`finish` stream chunks via `RunUsageTracker` (`agent/src/mastra/runs/token-quota.ts`) — delta-only, reconciled against the finish whole-run total, never double-counted. Counters are in-memory, single-instance, and die with the process (restart = fresh daily quota); workflows and the image-generation model are not metered.
```

- [ ] **Step 3: AGENTS.md testing-rules entry**

In the "Testing rules" section, inside the parenthesized run-lifecycle test list (the bullet listing registry concurrency, cancel idempotency, event replay, etc.), extend the list by appending after "`tool-error` chunk mapping,":

```markdown
token quota enforcement and usage reconciliation (store rollover/boundary/unlimited, tracker deltas + finish reconciliation, route 429 ordering before thread creation),
```

- [ ] **Step 4: Full check**

Run: `npm run check`
Expected: typecheck (storage → agent → client) + lint + all tests PASS. If the heap runs out, re-run with `NODE_OPTIONS=--max-old-space-size=8192`.

- [ ] **Step 5: Full build**

Run: `npm run build`
Expected: PASS. Same NODE_OPTIONS escape hatch.

- [ ] **Step 6: Whitespace check**

Run: `git diff --check` (after staging: `git diff --cached --check`)
Expected: no output (no whitespace errors).

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document TOKEN_DAILY_LIMIT per-user token quota"
```

---

## Self-review notes

- Spec coverage: config (Task 1), store + error + message (Task 2), recording semantics incl. cumulative-variant guard and finish reconciliation (Tasks 3–4), enforcement point + ordering + 429 shape + no-thread-on-block (Task 5), restart semantics + not-metered surfaces documented (Task 6 docs), default 500K (Task 1). Visibility = error message only — no client task, as approved.
- Type consistency: `TokenQuotaConsumer` (Task 2) is what `runExecution` accepts (Task 4) and `TokenQuotaStore implements TokenQuotaConsumer` (Task 2) so the singleton (Task 5) satisfies it structurally. `RunUsageTracker(consume)` callback shape matches Task 4's wiring.
- The `chunkPayload` helper already exists in `execute.ts` and is reused (Task 4); `chunkToRunEvent` is intentionally untouched — usage chunks still fall to `default: null`.
