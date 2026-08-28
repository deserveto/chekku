# LLM Thread Titles for Main Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 52-character prompt-truncation thread title with Mastra-native LLM-generated titles (first user message → ≤80-char summary) for the five main chat agents.

**Architecture:** Mastra `Memory({ options: { generateTitle: true } })` generates the title inside the run's memory-update phase after the first assistant response, but only when the thread title is empty. So `createAgentMemory` gains an opt-in flag (default off), the five main agents opt in, and `ensureFirstTurnThread` stops pre-setting a truncated title — it still creates the thread record (untitled) before the 202 so the thread lists instantly; the client's existing `'New conversation'` fallback covers the gap until the title lands.

**Tech Stack:** TypeScript, `@mastra/core` 1.49 / `@mastra/memory` 1.22 (installed), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-llm-thread-titles-design.md`

## Global Constraints

- Main agents (opt in): `main-agent`, `qa-web-agent`, `qa-android-agent`, `pm-agent`, `social-media-supervisor-agent`.
- Sub-agents (stay off): `social-media-content-writer`, `social-media-strategist-agent`, `visual-content-agent`.
- No new env vars, no custom title model, no client-side title code.
- `createAgentMemory()` default must remain title-generation-off (backwards compatible for all other call sites).
- Manual rename still wins (non-empty title suppresses Mastra regeneration) — nothing to implement, just do not break `renameThread`.
- Root commands: `npm run check`, `npm run build` (with `NODE_OPTIONS=--max-old-space-size=8192` if heap exhausts). Single file: `npx vitest run <path>` from repo root.
- Repo rule: never commit `.env*` secrets; untracked `agents-production.png` / `reports-production.png` must stay uncommitted.

---

### Task 1: `createAgentMemory` opt-in parameter

**Files:**
- Modify: `agent/src/mastra/processors/context-limit.ts:60-63`
- Test: `agent/src/mastra/processors/context-limit.test.ts`

**Interfaces:**
- Produces: `createAgentMemory(options?: { generateTitle?: boolean }): Memory` — Task 3 call sites pass `{ generateTitle: true }`.

- [ ] **Step 1: Write the failing test**

In `agent/src/mastra/processors/context-limit.test.ts`, extend the `createAgentMemory` describe block (right after the `'returns a fresh Memory instance per call...'` test, around line 101):

```typescript
  it('leaves thread title generation off by default', () => {
    const memory = createAgentMemory();
    expect(memory.getMergedThreadConfig().generateTitle).toBe(false);
  });

  it('opts into Mastra thread title generation when requested', () => {
    const memory = createAgentMemory({ generateTitle: true });
    expect(memory.getMergedThreadConfig().generateTitle).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/mastra/processors/context-limit.test.ts`
Expected: FAIL — TS error "Expected 0 arguments, but got 1" at `createAgentMemory({ generateTitle: true })`.

- [ ] **Step 3: Implement**

In `agent/src/mastra/processors/context-limit.ts`, replace:

```typescript
export function createAgentMemory(): Memory {
  return new Memory({ options: { lastMessages: AGENT_MEMORY_LAST_MESSAGES } });
}
```

with:

```typescript
export function createAgentMemory(
  options: { generateTitle?: boolean } = {},
): Memory {
  return new Memory({
    options: {
      lastMessages: AGENT_MEMORY_LAST_MESSAGES,
      generateTitle: options.generateTitle === true,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/mastra/processors/context-limit.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/processors/context-limit.ts agent/src/mastra/processors/context-limit.test.ts
git commit -m "feat(agent): add generateTitle opt-in to createAgentMemory"
```

---

### Task 2: Untitled first-turn thread creation

**Files:**
- Modify: `agent/src/mastra/runs/execute.ts:41-54` (MemoryAccess), `:154-187` (buildThreadTitle + ensureFirstTurnThread)
- Modify: `agent/src/mastra/routes/runs.ts:216-220` (comment only)
- Test: `agent/src/mastra/runs/execute.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `ensureFirstTurnThread(agent, { threadId, resourceId, prompt })` — signature unchanged (prompt still required: run summaries carry it); behavior change is untitled creation. `MemoryAccess.createThread` params lose `title`. `buildThreadTitle` is deleted — no other module imports it (verified: only `execute.ts`, `execute.test.ts`, and the `runs.ts` comment reference it).

- [ ] **Step 1: Update the tests (failing)**

In `agent/src/mastra/runs/execute.test.ts`:

1. Remove `buildThreadTitle` from the import at line 4.
2. Update `makeMemory` (line 25-35) to stop reading `params.title`:

```typescript
function makeMemory(existing: boolean) {
  const calls: { created: number } = { created: 0 };
  const memory: MemoryAccess = {
    getThreadById: async () => (existing ? { metadata: { kept: true } } : null),
    createThread: async (params) => {
      calls.created += 1;
      return params;
    },
  };
  return { memory, calls };
}
```

3. Delete the whole `describe('buildThreadTitle', ...)` block (lines 201-228).
4. Replace the `describe('ensureFirstTurnThread', ...)` block (lines 230-299) with:

```typescript
describe('ensureFirstTurnThread', () => {
  it('creates the missing thread record untitled so Mastra can generate the LLM title', async () => {
    const { memory, calls } = makeMemory(false);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'research the market',
    });

    expect(calls.created).toBe(1);
  });

  it('leaves an existing thread untouched', async () => {
    const { memory, calls } = makeMemory(true);
    const { agent } = makeAgent([], memory);

    await ensureFirstTurnThread(agent, {
      threadId: TUPLE.threadId,
      resourceId: TUPLE.resourceId,
      prompt: 'second turn',
    });

    expect(calls.created).toBe(0);
  });

  it('swallows storage failures so the run can still start', async () => {
    const brokenMemory: MemoryAccess = {
      getThreadById: async () => null,
      createThread: async () => {
        throw new Error('storage down');
      },
    };
    const { agent } = makeAgent([], brokenMemory);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'title me',
      }),
    ).resolves.toBeUndefined();
  });

  it('does nothing when the agent has no memory', async () => {
    const { agent } = makeAgent([]);

    await expect(
      ensureFirstTurnThread(agent, {
        threadId: TUPLE.threadId,
        resourceId: TUPLE.resourceId,
        prompt: 'title me',
      }),
    ).resolves.toBeUndefined();
  });
});
```

Note: line 304 (`const { memory, calls: memoryCalls } = makeMemory(true);`) and line 346 (`expect(memoryCalls.titles).toEqual([]);`) inside `runExecution` tests are the only other `makeMemory` call-site assertions — update line 346 to `expect(memoryCalls.created).toBe(0);` (execution does not create threads; titles are owned by `ensureFirstTurnThread` at run start). Lines 378 and 407 destructure only `{ memory }` and need no change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run agent/src/mastra/runs/execute.test.ts`
Expected: FAIL — `buildThreadTitle` import unresolved / title still passed.

- [ ] **Step 3: Implement**

In `agent/src/mastra/runs/execute.ts`:

1. `MemoryAccess.createThread` (lines 49-53) — drop the `title?: string;` line:

```typescript
  createThread(params: {
    threadId: string;
    resourceId: string;
  }): Promise<unknown>;
```

2. Delete `buildThreadTitle` (lines 154-160).
3. Replace `ensureFirstTurnThread` body's `createThread` call and doc comment (lines 162-187):

```typescript
/**
 * Creates the Memory thread record for a first turn before execution starts,
 * untitled. The record must exist before the 202 goes out so the thread is
 * listed the moment the client is told the run started, but the title stays
 * empty on purpose: Mastra's native title generation (generateTitle on the
 * agent's Memory) fires at first-turn completion only while the thread has no
 * title, and a pre-set truncated prompt title would suppress it. The client
 * renders its 'New conversation' fallback until the generated title lands.
 * Best-effort: on failure, Mastra's own thread creation during the run still
 * applies.
 */
export async function ensureFirstTurnThread(
  agent: RunnableAgent,
  params: { threadId: string; resourceId: string; prompt: string },
): Promise<void> {
  try {
    const memory = await agent.getMemory();
    if (!memory) return;
    const thread = await memory.getThreadById({ threadId: params.threadId });
    if (thread) return;
    await memory.createThread({
      threadId: params.threadId,
      resourceId: params.resourceId,
    });
  } catch {
    // Thread creation is best-effort; the run itself must still start.
  }
}
```

(`prompt` stays in the params type: the routes layer already has it in scope and callers pass it; keeping the signature stable avoids touching `parseStartRunRequest` wiring.)

4. In `agent/src/mastra/routes/runs.ts:216-219`, update the comment to:

```typescript
    // First turn: create the Memory thread record (untitled — Mastra's
    // generateTitle names the thread at first-turn completion) before
    // execution starts, so the thread is visible in listings the moment the
    // run starts, not when Mastra persists the first completed turn.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run agent/src/mastra/runs/execute.test.ts agent/src/mastra/routes/runs.test.ts`
Expected: PASS (runs.test.ts has no title assertions; it must stay green).

- [ ] **Step 5: Commit**

```bash
git add agent/src/mastra/runs/execute.ts agent/src/mastra/runs/execute.test.ts agent/src/mastra/routes/runs.ts
git commit -m "feat(agent): create first-turn threads untitled for LLM title generation"
```

---

### Task 3: Opt in the five main agents

**Files:**
- Modify: `agent/src/agents/main-agent.ts:12`
- Modify: `agent/src/agents/qa-web-agent.ts:21`
- Modify: `agent/src/agents/qa-android-agent.ts:111`
- Modify: `agent/src/agents/pm-agent.ts:52`
- Modify: `agent/src/agents/social-media-supervisor-agent.ts:133`
- Test: `agent/src/agents/__tests__/both-agents.test.ts`

**Interfaces:**
- Consumes: `createAgentMemory({ generateTitle: true })` from Task 1.
- Produces: five agents whose Memory has title generation enabled.

- [ ] **Step 1: Write the failing test**

In `agent/src/agents/__tests__/both-agents.test.ts`, append:

```typescript
describe('thread title generation (main agents only)', () => {
  it('enables Mastra title generation on the five main agents', async () => {
    for (const agent of [
      mainAgent,
      qaWebAgent,
      qaAndroidAgent,
      pmAgent,
      socialMediaSupervisorAgent,
    ]) {
      const memory = await agent.getMemory();
      expect(memory?.getMergedThreadConfig().generateTitle).toBe(true);
    }
  });

  it('keeps title generation off for sub-agents', async () => {
    for (const agent of [
      socialMediaContentWriter,
      socialMediaStrategistAgent,
      visualContentAgent,
    ]) {
      const memory = await agent.getMemory();
      expect(memory?.getMergedThreadConfig().generateTitle).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/src/agents/__tests__/both-agents.test.ts`
Expected: FAIL — `generateTitle` is `false` on the main agents.

- [ ] **Step 3: Implement**

In each of the five files, change `memory: createAgentMemory(),` to:

```typescript
  memory: createAgentMemory({ generateTitle: true }),
```

Files/lines: `main-agent.ts:12`, `qa-web-agent.ts:21`, `qa-android-agent.ts:111`, `pm-agent.ts:52`, `social-media-supervisor-agent.ts:133`. Do NOT touch the three sub-agent files.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/src/agents/__tests__/both-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/agents/main-agent.ts agent/src/agents/qa-web-agent.ts agent/src/agents/qa-android-agent.ts agent/src/agents/pm-agent.ts agent/src/agents/social-media-supervisor-agent.ts agent/src/agents/__tests__/both-agents.test.ts
git commit -m "feat(agent): enable LLM thread titles on main agents"
```

---

### Task 4: Documentation updates

**Files:**
- Modify: `AGENTS.md:82` (Agent run lifecycle bullet)
- Modify: `docs/ARCHITECTURE.md:461` (First-turn titles bullet)
- Modify: `docs/OPERATIONS.md:195` (phrasing check only)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update AGENTS.md line 82**

Replace the bullet that currently reads "First-turn thread titles are set server-side when the run starts (`ensureFirstTurnThread` ... 52-character prompt truncation ...)" with:

```markdown
- First-turn thread records are created server-side when the run starts (`ensureFirstTurnThread` in `agent/src/mastra/runs/execute.ts` creates the Memory thread record untitled before the 202 response is sent), so a new thread is listed the moment the prompt is sent; the client renders its `'New conversation'` fallback until the first turn completes. The LLM thread title (Mastra `generateTitle`, ≤80 chars from the first user message, agent's own model) is generated at first-turn completion for the five main agents (`main-agent`, `qa-web-agent`, `qa-android-agent`, `pm-agent`, `social-media-supervisor-agent` — `createAgentMemory({ generateTitle: true })`); sub-agents keep it off. A non-empty title (manual rename) permanently suppresses regeneration, and the browser never renames threads.
```

- [ ] **Step 2: Update docs/ARCHITECTURE.md line 461**

Replace the "**First-turn titles.**" bullet with:

```markdown
- **First-turn titles.** The server creates a missing Memory thread record untitled before the 202 start response is sent, so the thread appears in listings the moment the prompt is sent. Mastra's native title generation (`generateTitle` on the agent's Memory) then writes an LLM-generated title (≤80 chars, from the first user message) at first-turn completion for the five main agents; sub-agents and stored agents are unaffected. The client shows its `New conversation` fallback until then, and manual renames always win.
```

- [ ] **Step 3: Check docs/OPERATIONS.md line 195**

Current text: "Attachment filenames are sanitized (control characters collapsed, 120 code points max) before they reach the model prompt or a persisted thread title." — the sanitization claim is still true (filenames reach the model prompt and the title-generation input is derived from the message); no change needed. Leave as is.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md
git commit -m "docs: describe LLM thread title generation for main agents"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: typecheck (storage → agent → client) + lint + tests all pass. If the heap exhausts, re-run with `NODE_OPTIONS=--max-old-space-size=8192`.

- [ ] **Step 2: Run the full build**

Run: `npm run build`
Expected: success. Same heap note applies.

- [ ] **Step 3: Whitespace check**

Run: `git diff --check main...HEAD`
Expected: no output (no whitespace errors).

- [ ] **Step 4: Confirm untracked screenshots stay uncommitted**

Run: `git status --short`
Expected: only `agents-production.png` / `reports-production.png` untracked; everything else committed.
