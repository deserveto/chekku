# PM Competitive Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce PM competitive research tool caps per run and make every evidence-short run return an uncited-claim-free, unsaved incomplete report.

**Architecture:** Add one PM-only Mastra input-step processor that counts completed-step tool calls, removes exhausted tools, and treats Web Reader configuration failure as terminal. Keep synthesis in the existing `competitive-analysis` skill, but add an explicit evidence inventory and pre-draft completion gate. Existing save schema remains the deterministic persistence boundary.

**Tech Stack:** TypeScript 6 strict mode, Mastra 1.50 processors and skills, Vitest, existing OpenAI-compatible model gateway, SearXNG, hosted Jina Reader, Garage.

## Global Constraints

- Work on `integration/pm-competitive-analysis` in `C:\Users\diazh\OneDrive\文档\MAGANG\chekku`.
- Read `AGENTS.md` and `docs/superpowers/specs/2026-07-24-pm-competitive-contract-hardening-design.md` before editing.
- Follow regression-first TDD and observe focused tests fail before implementation.
- Keep `agent/src/mastra/index.ts` as the single Mastra composition root.
- Keep PM Agent direct and code-defined with `maxSteps: 18`.
- Preserve all eight PM direct tools and both existing skills.
- Preserve fixed Garage, SearXNG, and Web Reader MCP registries exactly.
- Keep `createAgentContextLimiter()` active and `createCharBudgetGuard()` last.
- Do not add provider, crawler, recursive-link, browser, PDF, upload, credential, endpoint, or storage behavior.
- Never read, print, log, or commit environment values. Use only literal invalid test values when forcing configuration failure.
- Do not commit changes unless the user explicitly requests a commit.

## File Structure

- Create `agent/src/mastra/processors/competitive-research-guard.ts`: pure tool-count/error classification plus Mastra input-step processor.
- Create `agent/src/mastra/processors/competitive-research-guard.test.ts`: deterministic cap, failure, filtering, and safe-instruction tests.
- Modify `agent/src/agents/pm-agent.ts`: place guard before existing context processors.
- Modify `agent/src/agents/__tests__/both-agents.test.ts`: assert processor order and unchanged tools/skills.
- Modify `agent/src/agents/pm-agent-skills.ts`: evidence inventory, terminal configuration behavior, and exact incomplete branch.
- Modify `agent/src/agents/__tests__/pm-agent-skills.test.ts`: regression assertions for observed live failures.
- Modify `AGENTS.md`: record PM guard invariant.
- Modify `docs/ARCHITECTURE.md`: distinguish deterministic tool caps from model-driven synthesis.
- Modify `docs/OPERATIONS.md`: document terminal configuration behavior and incomplete validation.

---

### Task 1: Deterministic Competitive Research Guard

**Files:**
- Create: `agent/src/mastra/processors/competitive-research-guard.test.ts`
- Create: `agent/src/mastra/processors/competitive-research-guard.ts`
- Modify: `agent/src/agents/pm-agent.ts:3-52`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts:40-66`

**Interfaces:**
- Consumes: Mastra `InputProcessor`, completed-step `toolCalls` and `content`, PM direct tool names.
- Produces: `createCompetitiveResearchGuard(): InputProcessor`, `getCompetitiveResearchDecision(steps, availableTools)`, `COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION`.

- [ ] **Step 1: Add failing processor tests**

Create `agent/src/mastra/processors/competitive-research-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION,
  createCompetitiveResearchGuard,
  getCompetitiveResearchDecision,
} from './competitive-research-guard.js';

const tools = [
  'search_web',
  'read_web_page',
  'save_competitive_analysis_to_garage',
  'list_competitive_analyses_from_garage',
];

const calls = (...toolNames: string[]) => ({
  toolCalls: toolNames.map((toolName, index) => ({
    type: 'tool-call',
    toolCallId: `call-${toolName}-${index}`,
    toolName,
  })),
  content: [],
});

const readerError = (category: string, message: string) => ({
  toolCalls: [{ type: 'tool-call', toolCallId: 'call-reader', toolName: 'read_web_page' }],
  content: [{
    type: 'tool-error',
    toolCallId: 'call-reader',
    toolName: 'read_web_page',
    error: { cause: { category, message } },
  }],
});

describe('competitive research guard', () => {
  it('removes search after three attempts and preserves unrelated tools', () => {
    const decision = getCompetitiveResearchDecision([
      calls('search_web'),
      calls('search_web'),
      calls('search_web'),
    ], tools);

    expect(decision.activeTools).not.toContain('search_web');
    expect(decision.activeTools).toContain('list_competitive_analyses_from_garage');
  });

  it('removes Reader after eight attempts including failures', () => {
    const decision = getCompetitiveResearchDecision([
      ...Array.from({ length: 7 }, () => calls('read_web_page')),
      readerError('unavailable', 'Web Reader is unavailable. Try again later.'),
    ], tools);

    expect(decision.activeTools).not.toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(false);
  });

  it('removes save after one attempt', () => {
    const decision = getCompetitiveResearchDecision([
      calls('save_competitive_analysis_to_garage'),
    ], tools);

    expect(decision.activeTools).not.toContain('save_competitive_analysis_to_garage');
  });

  it('stops Reader immediately after terminal configuration failure', () => {
    const decision = getCompetitiveResearchDecision([
      readerError('configuration', 'Web Reader is not configured.'),
    ], tools);

    expect(decision.activeTools).not.toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(true);
  });

  it('keeps Reader after a nonterminal failure while slots remain', () => {
    const decision = getCompetitiveResearchDecision([
      readerError('unavailable', 'Web Reader is unavailable. Try again later.'),
    ], tools);

    expect(decision.activeTools).toContain('read_web_page');
    expect(decision.terminalConfigurationFailure).toBe(false);
  });

  it('injects only fixed safe terminal guidance', async () => {
    const processor = createCompetitiveResearchGuard();
    const result = await processor.processInputStep?.({
      steps: [readerError('configuration', 'Web Reader is not configured.')],
      tools: Object.fromEntries(tools.map((tool) => [tool, {}])),
      systemMessages: [],
    } as never) as { activeTools: string[]; systemMessages: Array<{ content: string }> };

    expect(processor.id).toBe('competitive-research-guard');
    expect(result.activeTools).not.toContain('read_web_page');
    expect(result.systemMessages.at(-1)?.content).toBe(COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION);
    expect(COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION).toBe(
      'Web Reader configuration failed for this run. Do not call read_web_page again. Return the incomplete competitive-analysis branch using only successful page evidence from this run. Do not save it and do not emit Saved analysisId:.'
    );
  });
});
```

Update `both-agents.test.ts` expected processor IDs:

```ts
expect((await pmAgent.listConfiguredInputProcessors()).map(({ id }) => id)).toEqual([
  'competitive-research-guard',
  'token-limiter',
  'char-budget-guard',
]);
```

- [ ] **Step 2: Run tests and verify red state**

Run:

```powershell
npx vitest run agent/src/mastra/processors/competitive-research-guard.test.ts agent/src/agents/__tests__/both-agents.test.ts
```

Expected: FAIL because `competitive-research-guard.ts` does not exist and PM Agent still lists only two processors.

- [ ] **Step 3: Implement pure decision helper and processor**

Create `agent/src/mastra/processors/competitive-research-guard.ts`:

```ts
import type { InputProcessor } from '@mastra/core/processors';

const SEARCH_TOOL = 'search_web';
const READER_TOOL = 'read_web_page';
const SAVE_TOOL = 'save_competitive_analysis_to_garage';
const READER_CONFIGURATION_MESSAGE = 'Web Reader is not configured.';

const TOOL_LIMITS: Readonly<Record<string, number>> = {
  [SEARCH_TOOL]: 3,
  [READER_TOOL]: 8,
  [SAVE_TOOL]: 1,
};

export const COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION =
  'Web Reader configuration failed for this run. Do not call read_web_page again. Return the incomplete competitive-analysis branch using only successful page evidence from this run. Do not save it and do not emit Saved analysisId:.';

interface CompetitiveResearchStep {
  toolCalls?: readonly unknown[];
  content?: readonly unknown[];
}

export interface CompetitiveResearchDecision {
  activeTools: string[];
  terminalConfigurationFailure: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReaderConfigurationError(value: unknown): boolean {
  if (value instanceof Error) {
    return value.message === READER_CONFIGURATION_MESSAGE
      || isReaderConfigurationError(value.cause);
  }
  if (!isRecord(value)) return false;
  return value.message === READER_CONFIGURATION_MESSAGE
    || value.category === 'configuration'
    || isReaderConfigurationError(value.cause);
}

function isTerminalReaderError(part: unknown): boolean {
  return isRecord(part)
    && part.type === 'tool-error'
    && part.toolName === READER_TOOL
    && isReaderConfigurationError(part.error);
}

export function getCompetitiveResearchDecision(
  steps: readonly CompetitiveResearchStep[],
  availableTools: readonly string[],
): CompetitiveResearchDecision {
  const counts = new Map<string, number>();
  let terminalConfigurationFailure = false;

  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (!isRecord(call) || typeof call.toolName !== 'string') continue;
      counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
    }
    terminalConfigurationFailure ||= (step.content ?? []).some(isTerminalReaderError);
  }

  const activeTools = availableTools.filter((toolName) => {
    if (toolName === READER_TOOL && terminalConfigurationFailure) return false;
    const limit = TOOL_LIMITS[toolName];
    return limit === undefined || (counts.get(toolName) ?? 0) < limit;
  });

  return { activeTools, terminalConfigurationFailure };
}

export function createCompetitiveResearchGuard(): InputProcessor {
  return {
    id: 'competitive-research-guard',
    processInputStep: ({ steps, tools, activeTools, systemMessages }) => {
      const availableTools = activeTools ?? Object.keys(tools ?? {});
      const decision = getCompetitiveResearchDecision(steps, availableTools);
      const toolsChanged = decision.activeTools.length !== availableTools.length;
      if (!toolsChanged && !decision.terminalConfigurationFailure) return;

      return {
        activeTools: decision.activeTools,
        ...(decision.terminalConfigurationFailure
          ? {
              systemMessages: [
                ...systemMessages,
                { role: 'system', content: COMPETITIVE_RESEARCH_TERMINAL_INSTRUCTION },
              ],
            }
          : {}),
      };
    },
  };
}
```

- [ ] **Step 4: Wire processor before context controls**

In `agent/src/agents/pm-agent.ts`, add:

```ts
import { createCompetitiveResearchGuard } from '../mastra/processors/competitive-research-guard.js';
```

Replace processor configuration with:

```ts
inputProcessors: [
  createCompetitiveResearchGuard(),
  createAgentContextLimiter(),
  createCharBudgetGuard(),
],
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npx vitest run agent/src/mastra/processors/competitive-research-guard.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/processors/context-limit.test.ts
npm run typecheck --workspace agent
```

Expected: all tests PASS and agent typecheck exits 0. If Mastra's exact step type rejects the structural helper call, narrow only the local `CompetitiveResearchStep` interface or cast at the processor boundary; do not import private AI SDK internals.

- [ ] **Step 6: Review checkpoint**

Inspect `git diff -- agent/src/mastra/processors/competitive-research-guard.ts agent/src/mastra/processors/competitive-research-guard.test.ts agent/src/agents/pm-agent.ts agent/src/agents/__tests__/both-agents.test.ts`. Confirm no reusable tool or MCP registry changed. Do not commit unless requested.

---

### Task 2: Evidence-Gated Incomplete Report Contract

**Files:**
- Modify: `agent/src/agents/__tests__/pm-agent-skills.test.ts:60-113`
- Modify: `agent/src/agents/pm-agent-skills.ts:36-103`

**Interfaces:**
- Consumes: fixed safe Reader error `Web Reader is not configured.`, existing complete report template and save tool.
- Produces: exact incomplete H1 and current-run evidence-only branch in `competitiveAnalysisInstructions`.

- [ ] **Step 1: Add failing skill regression assertions**

Add this test to `pm-agent-skills.test.ts`:

```ts
it('stops terminal Reader retries and gates incomplete output on current-run evidence', () => {
  expect(competitiveAnalysisInstructions).toContain(
    'Treat "Web Reader is not configured." as terminal for this run',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Stop calling read_web_page immediately and do not spend remaining Reader slots',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Maintain an evidence inventory from successful read_web_page results in this run',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Immediately before drafting, count one evidenced anchor and five to seven evidenced competitors',
  );
  expect(competitiveAnalysisInstructions).toContain(
    '# Incomplete Competitive Analysis: <anchor product>',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Do not fill missing evidence from model knowledge, general knowledge, search snippets, or unread URLs',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'For unevidenced products, list only the product name, missing evidence, safe failure, and suggested user action',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Never call save_competitive_analysis_to_garage from the incomplete branch',
  );
  expect(competitiveAnalysisInstructions).toContain(
    'Never emit "Saved analysisId:" from the incomplete branch',
  );
});
```

Change the existing incomplete-title assertion to exact H1:

```ts
expect(competitiveAnalysisInstructions).toContain(
  'start with exactly `# Incomplete Competitive Analysis: <anchor product>`',
);
```

- [ ] **Step 2: Run skill test and verify red state**

Run:

```powershell
npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts
```

Expected: FAIL on new exact instruction assertions.

- [ ] **Step 3: Add terminal failure and evidence inventory instructions**

In `pm-agent-skills.ts`, append under `## Fixed research budget`:

```text
- Treat "Web Reader is not configured." as terminal for this run. Stop calling read_web_page immediately and do not spend remaining Reader slots. Continue directly to the incomplete completion gate. Availability, timeout, and individual-page failures are nonterminal and may use remaining slots.
```

Insert after `## Evidence rules` and before `## Untrusted page content`:

```text
## Evidence inventory and completion gate

- Maintain an evidence inventory from successful read_web_page results in this run. Record product name, successfully read official or primary URL, and claims directly supported by that page. A search result, failed read, unread URL, or model memory does not evidence a product.
- Immediately before drafting, count one evidenced anchor and five to seven evidenced competitors. Enter the completed-report branch only when both counts pass. Otherwise enter the incomplete branch.
- Do not fill missing evidence from model knowledge, general knowledge, search snippets, or unread URLs. Do not write feature, pricing, positioning, comparison, gap, opportunity, risk, or recommendation claims about an unevidenced product.
```

- [ ] **Step 4: Replace incomplete behavior with exact branch contract**

Replace the current incomplete bullet at lines 98-100 with:

```text
- If the evidence minimum cannot be met, start with exactly `# Incomplete Competitive Analysis: <anchor product>`.
- In the incomplete branch, return evidenced products and partial findings supported by inline links to successful reads from this run. For unevidenced products, list only the product name, missing evidence, safe failure, and suggested user action. Do not include unsupported matrix cells or completed-report conclusions.
- Never call save_competitive_analysis_to_garage from the incomplete branch. Never emit "Saved analysisId:" from the incomplete branch. Do not fabricate claims, convert unknowns into negatives, or silently lower the five-competitor minimum.
```

Keep complete save behavior unchanged.

- [ ] **Step 5: Run focused skill and agent tests**

Run:

```powershell
npx vitest run agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts
npm run typecheck --workspace agent
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Review checkpoint**

Inspect `git diff -- agent/src/agents/pm-agent-skills.ts agent/src/agents/__tests__/pm-agent-skills.test.ts`. Confirm complete-report headings, source rules, five-to-seven competitor minimum, and save behavior remain intact. Do not commit unless requested.

---

### Task 3: Documentation And End-To-End Verification

**Files:**
- Modify: `AGENTS.md:198-213`
- Modify: `docs/ARCHITECTURE.md:127-131`
- Modify: `docs/OPERATIONS.md:200-232,442-466`

**Interfaces:**
- Consumes: Task 1 deterministic caps and Task 2 incomplete branch.
- Produces: current contributor, architecture, and operator contracts plus live validation evidence.

- [ ] **Step 1: Update repository invariants**

In `AGENTS.md` PM analyses section, add these requirements:

```text
- Keep `competitive-research-guard` first in PM Agent `inputProcessors`, before `createAgentContextLimiter()` and final `createCharBudgetGuard()`. It removes `search_web`, `read_web_page`, and competitive save after 3, 8, and 1 attempted calls respectively; failed calls count.
- Treat `Web Reader is not configured.` as terminal for a competitive run: the guard removes Reader immediately and injects only fixed safe incomplete-branch guidance. Other Reader failures may use remaining slots.
- Before drafting, build a current-run successful-read evidence inventory. If anchor plus five competitors are not evidenced, use exact H1 `# Incomplete Competitive Analysis: <anchor product>`, make no claims for unevidenced products, do not save, and emit no `Saved analysisId:`.
```

- [ ] **Step 2: Update architecture and operations docs**

In `docs/ARCHITECTURE.md`, change PM Agent processor description to name `competitive-research-guard`, state that 3/8/1 attempt caps are code-enforced by next-step tool removal, and state prose synthesis remains model-driven. Add terminal Reader configuration behavior and exact incomplete H1 to the competitive paragraph.

In `docs/OPERATIONS.md`, update PM competitive analysis and troubleshooting:

```text
PM Agent enforces the 3/8/1 attempted-call caps by removing exhausted tools before the next model step. Failed calls consume slots. `Web Reader is not configured.` is terminal for the run, so Reader is removed immediately; availability, timeout, and page-specific failures may consume remaining slots.
```

Add to incomplete troubleshooting:

```text
An incomplete response must start with `# Incomplete Competitive Analysis: <anchor product>`, make claims only from successful current-run reads, omit save calls, and contain no `Saved analysisId:`. Unevidenced products may appear only as missing-evidence entries with safe failure context and suggested action.
```

- [ ] **Step 3: Run focused deterministic verification**

Run:

```powershell
npx vitest run agent/src/mastra/processors/competitive-research-guard.test.ts agent/src/agents/__tests__/pm-agent-skills.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/processors/context-limit.test.ts agent/src/mastra/tools/competitive-analysis-tools.test.ts
npm run typecheck --workspace agent
git diff --check
```

Expected: all focused tests PASS, agent typecheck exits 0, and diff check prints nothing.

- [ ] **Step 4: Restart normally and repeat configured live analysis**

Stop only Chekku dev processes identified on ports 3000 and 4111. Relaunch `scripts/dev.sh` with the existing generated environment without printing values. Poll `http://localhost:4111/healthz` and `http://localhost:3000` until ready.

Run prompt in a new PM Agent thread:

```text
can you research gpt vs claude vs gemini
```

Record only safe behavior:

- no more than three Search Web cards;
- no more than eight Read Web Page cards;
- complete output only if anchor plus at least five competitors have successful primary reads;
- otherwise exact incomplete H1, no unsupported product claims, no save card, no `Saved analysisId:`;
- complete output has one save card and a canonical `pca_...` receipt.

- [ ] **Step 5: Force terminal configuration failure without modifying secret files**

Stop only Chekku dev processes. Relaunch through the same process-service method used for manual validation, but set inherited environment variable `WEB_READER_API_KEY=invalid-live-contract-test` for that process only. Do not edit or read `agent/.env` or `agent/.env.development`.

Run the same prompt in a new PM Agent thread and verify:

- exactly one failed Reader call with fixed `Web Reader is not configured.`;
- no later Reader calls;
- response starts `# Incomplete Competitive Analysis: GPT`;
- claims, if any, come only from successful reads before the terminal error;
- unevidenced Claude, Gemini, or agent-selected products have no feature/pricing/comparison claims;
- no save tool call;
- no `Saved analysisId:`.

If any check fails, return to systematic debugging and add a failing deterministic regression before another implementation change.

- [ ] **Step 6: Restore normal configured stack and rerun Reader smoke**

Stop the invalid-key dev processes. Relaunch normally so `agent/.env.development` supplies the replacement key. Run without printing the key:

```powershell
$env:DOTENV_CONFIG_PATH='agent/.env.development'
$env:npm_lifecycle_event='test:web-reader:live'
node -r dotenv/config ./node_modules/vitest/vitest.mjs run agent/src/mastra/web-reader/client.live.test.ts
```

Expected: 1 test file PASS and 1 test PASS.

- [ ] **Step 7: Run required repository verification**

Run sequentially from repository root:

```powershell
npm run check
npm run build
git diff --check
git status --short --branch
```

Expected: `npm run check` exits 0, `npm run build` exits 0, diff check prints nothing, and status contains only intended source, test, design, plan, and documentation changes. No environment, database, build output, screenshot, or log file may be tracked.

- [ ] **Step 8: Review checkpoint**

Review complete diff against `docs/superpowers/specs/2026-07-24-pm-competitive-contract-hardening-design.md`. Verify no secret value appears and no unrelated file changed. Do not commit, push, or create a PR unless explicitly requested.
