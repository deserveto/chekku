# Chat Slash-Command Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat slash-command picker that opens on leading `/`, lists the active agent's skills (dynamic via the native skills endpoint), and inserts `/<skill-name> ` so the user can type args and Enter to send.

**Architecture:** Client-only. New `agent-skills.ts` fetch wrapper + cache; new `command-menu.tsx` listbox popover; `chat-studio.tsx` gains picker state, trigger detection, keyboard interception, and renders `<CommandMenu>`. Dispatch reuses the existing `sendMessage()` → `agent.stream()` → PM-agent prompt routing. No backend changes.

**Tech Stack:** TypeScript strict, Next.js 16 App Router, React 19, Vitest, existing `@mastra/client-js` proxied through `/api/agent/*`.

## Global Constraints

- Work in `C:\Users\diazh\OneDrive\文档\MAGANG\chekku` on the current branch.
- Read `AGENTS.md` and `docs/superpowers/specs/2026-07-24-chat-slash-commands-design.md` before editing.
- Client-only: do NOT modify agents, `route.ts` proxy logic, storage, MCP registries, skills, or env. The native `GET /api/agents/{agentId}/skills` endpoint already exists; use it through the existing same-origin proxy.
- Keep `agent/src/mastra/index.ts` as the single Mastra composition root. No new backend route.
- Browser modules must never import `@chekku/storage`.
- Follow regression-first TDD: observe each focused test fail before production code.
- Keyboard interception in `keyDown` must run BEFORE the existing Enter→send branch so command selection never accidentally sends.
- Do not read, print, log, or commit environment values.
- Do not commit unless the user explicitly requests it.

## File Structure

### New files

- `client/src/lib/agent-skills.ts` — `listAgentSkills(agentId)` fetch wrapper + per-agent cache + `AgentSkillSummary` type.
- `client/src/lib/agent-skills.test.ts` — URL, normalization, sorting, caching, failure-degradation tests.
- `client/src/components/chat/command-menu.tsx` — stateless accessible listbox popover.
- `client/src/components/chat/command-menu.test.tsx` — render, aria, onSelect, empty-state tests.

### Modified files

- `client/src/components/chat/chat-studio.tsx` — picker state, skill fetch effect, trigger detection in `onChange`, keyboard interception in `keyDown`, render `<CommandMenu>`.
- `client/src/lib/ui-structure.test.ts` — replace the generic suggestion-grid ban with a command-menu assertion (the command menu is intentional; the old suggestion grid stays banned).
- `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` — user/operator docs.

---

### Task 1: Agent Skills Fetch Wrapper

**Files:**
- Create: `client/src/lib/agent-skills.ts`
- Create: `client/src/lib/agent-skills.test.ts`

**Interfaces:**
- Consumes: same-origin `GET /api/agent/api/agents/{agentId}/skills` (native Mastra endpoint, proxied).
- Produces: `AgentSkillSummary`, `listAgentSkills(agentId): Promise<AgentSkillSummary[]>`.

- [ ] **Step 1: Write failing tests**

Create `client/src/lib/agent-skills.test.ts`. The module must export a `__resetCache` test helper.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listAgentSkills, __resetCache, type AgentSkillSummary } from './agent-skills.js';

function mockFetch(payload: unknown, ok = true) {
  const response = { ok, json: async () => payload } as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

describe('listAgentSkills', () => {
  afterEach(() => __resetCache());

  it('calls the proxied native skills endpoint for the agent', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'competitive-analysis', description: 'd', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent/api/agents/pm-agent/skills'),
      expect.any(Object),
    );
  });

  it('returns user-invocable skills sorted by name', async () => {
    mockFetch({
      skills: [
        { name: 'weekly-report-analysis', description: 'w', 'user-invocable': true },
        { name: 'competitive-analysis', description: 'c', 'user-invocable': true },
        { name: 'internal-only', 'user-invocable': false },
      ],
    });
    const skills = await listAgentSkills('pm-agent');
    expect(skills.map((s) => s.name)).toEqual(['competitive-analysis', 'weekly-report-analysis']);
    expect(skills[0]).toMatchObject({ name: 'competitive-analysis', description: 'c', userInvocable: true });
  });

  it('caches per agentId and does not refetch', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'a', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    await listAgentSkills('pm-agent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches when agentId changes', async () => {
    const fetchSpy = mockFetch({ skills: [{ name: 'a', 'user-invocable': true }] });
    await listAgentSkills('pm-agent');
    await listAgentSkills('main-agent');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns [] on fetch failure without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const skills = await listAgentSkills('pm-agent');
    expect(skills).toEqual([]);
  });

  it('handles endpoint returning a bare array', async () => {
    mockFetch([{ name: 'competitive-analysis', 'user-invocable': true }]);
    const skills = await listAgentSkills('pm-agent');
    expect(skills.map((s) => s.name)).toEqual(['competitive-analysis']);
  });
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx vitest run client/src/lib/agent-skills.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the wrapper**

Create `client/src/lib/agent-skills.ts`:

```ts
export interface AgentSkillSummary {
  name: string;
  description?: string;
  userInvocable?: boolean;
}

interface RawSkill {
  name?: unknown;
  description?: unknown;
  'user-invocable'?: unknown;
}

const cache = new Map<string, AgentSkillSummary[]>();

export function __resetCache(): void {
  cache.clear();
}

function normalize(raw: unknown): AgentSkillSummary[] {
  const list: RawSkill[] = Array.isArray(raw)
    ? (raw as RawSkill[])
    : Array.isArray((raw as { skills?: RawSkill[] })?.skills)
      ? ((raw as { skills: RawSkill[] }).skills)
      : [];
  return list
    .filter((s): s is RawSkill & { name: string } => typeof s?.name === 'string')
    .filter((s) => s['user-invocable'] !== false)
    .map((s) => ({
      name: s.name,
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      ...(s['user-invocable'] === true ? { userInvocable: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAgentSkills(agentId: string): Promise<AgentSkillSummary[]> {
  const cached = cache.get(agentId);
  if (cached) return cached;
  try {
    const response = await fetch(`/api/agent/api/agents/${encodeURIComponent(agentId)}/skills`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      cache.set(agentId, []);
      return [];
    }
    const skills = normalize(await response.json());
    cache.set(agentId, skills);
    return skills;
  } catch {
    cache.set(agentId, []);
    return [];
  }
}
```

- [ ] **Step 4: Run tests and verify green**

Run: `npx vitest run client/src/lib/agent-skills.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace client && npm run lint --workspace client`
Expected: exit 0.

- [ ] **Step 6: Review checkpoint**

Inspect `git diff -- client/src/lib/agent-skills.ts client/src/lib/agent-skills.test.ts`. Confirm no `@chekku/storage` import and no backend file touched. Do not commit unless requested.

---

### Task 2: Command Menu Component

**Files:**
- Create: `client/src/components/chat/command-menu.tsx`
- Create: `client/src/components/chat/command-menu.test.tsx`

**Interfaces:**
- Consumes: `AgentSkillSummary` from `agent-skills.ts`.
- Produces: `CommandMenu` presentational component.

- [ ] **Step 1: Write failing tests**

Create `client/src/components/chat/command-menu.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CommandMenu } from './command-menu.js';

const skills = [
  { name: 'competitive-analysis', description: 'Research products' },
  { name: 'weekly-report-analysis', description: 'Weekly risk' },
];

describe('CommandMenu', () => {
  it('renders /skills plus one row per skill', () => {
    render(<CommandMenu commands={skills} activeIndex={0} onSelect={() => {}} />);
    expect(screen.getByText('/skills')).toBeTruthy();
    expect(screen.getByText('/competitive-analysis')).toBeTruthy();
    expect(screen.getByText('/weekly-report-analysis')).toBeTruthy();
  });

  it('marks the active option with aria-selected and aria-activedescendant', () => {
    const { container } = render(<CommandMenu commands={skills} activeIndex={1} onSelect={() => {}} />);
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.getAttribute('aria-activedescendant')).toBeTruthy();
    const options = container.querySelectorAll('[role="option"]');
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelect with the skill name', () => {
    const onSelect = vi.fn();
    render(<CommandMenu commands={skills} activeIndex={0} onSelect={onSelect} />);
    screen.getByText('/competitive-analysis').click();
    expect(onSelect).toHaveBeenCalledWith('competitive-analysis');
  });

  it('calls onSelect with "skills" for the /skills row', () => {
    const onSelect = vi.fn();
    render(<CommandMenu commands={skills} activeIndex={0} onSelect={onSelect} />);
    screen.getByText('/skills').click();
    expect(onSelect).toHaveBeenCalledWith('skills');
  });

  it('renders /skills alone when there are no skills', () => {
    render(<CommandMenu commands={[]} activeIndex={0} onSelect={() => {}} />);
    expect(screen.getByText('/skills')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests and verify red state**

Run: `npx vitest run client/src/components/chat/command-menu.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `client/src/components/chat/command-menu.tsx`:

```tsx
import type { AgentSkillSummary } from '../../lib/agent-skills.js';

export interface CommandMenuProps {
  commands: readonly AgentSkillSummary[];
  activeIndex: number;
  onSelect: (name: string) => void;
}

export function CommandMenu({ commands, activeIndex, onSelect }: CommandMenuProps) {
  const rows: Array<{ name: string; label: string; description?: string }> = [
    { name: 'skills', label: '/skills', description: 'Show all skills' },
    ...commands.map((c) => ({ name: c.name, label: `/${c.name}`, description: c.description })),
  ];
  const total = rows.length;
  const wrapped = ((activeIndex % total) + total) % total;
  const activeId = `cmd-${rows[wrapped]!.name}`;
  return (
    <div className="chat-command-menu" role="listbox" aria-label="Skill commands" aria-activedescendant={activeId}>
      {rows.map((row, index) => (
        <button
          key={row.name}
          id={`cmd-${row.name}`}
          type="button"
          role="option"
          aria-selected={index === wrapped}
          className="chat-command-menu__option"
          onClick={() => onSelect(row.name)}
        >
          <span className="chat-command-menu__label">{row.label}</span>
          {row.description ? <span className="chat-command-menu__desc">{row.description}</span> : null}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests and verify green**

Run: `npx vitest run client/src/components/chat/command-menu.test.tsx`
Expected: 5 tests PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace client && npm run lint --workspace client`
Expected: exit 0.

- [ ] **Step 6: Review checkpoint**

Inspect the diff. Confirm the component is stateless (all state in ChatStudio) and accessible (listbox/option roles). Do not commit unless requested.

---

### Task 3: ChatStudio Integration And Docs

**Files:**
- Modify: `client/src/components/chat/chat-studio.tsx`
- Modify: `client/src/lib/ui-structure.test.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`

**Interfaces:**
- Consumes: `listAgentSkills` + `AgentSkillSummary` (Task 1), `CommandMenu` (Task 2).
- Produces: open-on-`/`, filtered, keyboard-navigable picker that inserts `/<name> `.

- [ ] **Step 1: Read the current composer and plan the edits**

Read `client/src/components/chat/chat-studio.tsx` around these anchors (verify line numbers may have shifted):
- input state `input` near line 91;
- `sendMessage` near line 336;
- `keyDown` near line 436 (the Enter→send branch);
- the `<textarea>` + form near line 726-739;
- `agentId` near line 98.

- [ ] **Step 2: Add picker state and skill fetch**

Near the `input` state, add:

```ts
const [commandOpen, setCommandOpen] = useState(false);
const [commandIndex, setCommandIndex] = useState(0);
const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
```

Add an effect that fetches skills when `agentId` changes:

```ts
useEffect(() => {
  let cancelled = false;
  listAgentSkills(agentId).then((result) => {
    if (!cancelled) setSkills(result);
  });
  return () => { cancelled = true; };
}, [agentId]);
```

- [ ] **Step 3: Trigger detection in onChange**

In the textarea `onChange`, after `setInput(value)`, compute whether the picker should be open:

```ts
const isCommand = value.trimStart().startsWith('/');
setCommandOpen(isCommand);
if (isCommand) setCommandIndex(0);
```

- [ ] **Step 4: Keyboard interception before Enter→send**

Restructure `keyDown` so that when `commandOpen` is true, navigation/selection/close run first and return, BEFORE the existing Enter→send logic:

```ts
const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (commandOpen) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((i) => i + 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((i) => i - 1); return; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectCommand();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); setCommandOpen(false); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
};
```

`selectCommand` resolves the active row (`/skills` at index 0, skills after) and inserts:

```ts
const selectCommand = () => {
  const rows = ['skills', ...skills.map((s) => s.name)];
  const total = rows.length;
  const wrapped = ((commandIndex % total) + total) % total;
  const name = rows[wrapped]!;
  if (name === 'skills') {
    // /skills shows the full catalog: keep picker open, reset filter by clearing trailing text
    setInput('/');
    setCommandIndex(0);
    return;
  }
  setInput(`/${name} `);
  setCommandOpen(false);
  setCommandIndex(0);
};
```

- [ ] **Step 5: Render the picker**

Inside `.chat-composer` (the form), wrap the textarea in a `position: relative` container and render `<CommandMenu>` above it when `commandOpen`:

```tsx
<div className="chat-composer__input" style={{ position: 'relative' }}>
  {commandOpen ? (
    <CommandMenu
      commands={filteredSkills}
      activeIndex={commandIndex}
      onSelect={(name) => { /* same logic as selectCommand for a clicked row */ }}
    />
  ) : null}
  <textarea ... />
</div>
```

`filteredSkills` is derived from `skills` and the text after `/`. `/skills` (exact) shows the full list; otherwise filter by name substring (case-insensitive). Compute it inline or with `useMemo`.

- [ ] **Step 6: Add focused ChatStudio behavior tests**

Add tests (extend the existing chat-studio test file or add `chat-studio.command.test.tsx`) covering:
- leading `/` opens the picker; `/` mid-text does not;
- typing `/comp` filters to `competitive-analysis`;
- ArrowDown/ArrowUp move the highlight (wrap-around);
- Enter while open selects and does NOT send; Enter while closed sends;
- Escape closes without inserting;
- selecting `/competitive-analysis` sets input to `/competitive-analysis `.

Mock `listAgentSkills` to return a fixed skill set.

- [ ] **Step 7: Update ui-structure test**

In `client/src/lib/ui-structure.test.ts`, find the assertion banning `chat-suggestion-grid` / `suggestions`. Keep banning the old suggestion grid, but add an assertion that the command menu is a real component (e.g. import `CommandMenu` and assert it is a function, and that `chat-studio.tsx` source contains `CommandMenu`). This makes the picker intentional rather than accidentally re-banned.

- [ ] **Step 8: Add styles**

In `client/src/app/studio.css`, add `.chat-command-menu` (absolute, anchored above composer, bordered panel) and `.chat-command-menu__option` / `__label` / `__desc` rules, including a `[aria-selected="true"]` highlight and focus-visible outline. Join the existing mobile one-column media query if needed.

- [ ] **Step 9: Update docs**

- `README.md`: add a line that typing `/` in chat opens skill commands, with the example `/competitive-analysis gpt vs claude vs gemini`.
- `docs/ARCHITECTURE.md`: note the chat composer exposes the active agent's skills through a command picker backed by the native skills endpoint.
- `docs/OPERATIONS.md`: document `/` command usage and that skills come from the active agent (empty for agents with none).

- [ ] **Step 10: Run focused tests + typecheck + lint**

Run:
```
npx vitest run client/src/lib/agent-skills.test.ts client/src/components/chat/command-menu.test.tsx client/src/lib/ui-structure.test.ts
npm run typecheck --workspace client
npm run lint --workspace client
```
Expected: all PASS, exit 0.

- [ ] **Step 11: Full verification**

Run from repo root:
```
npm run check
npm run build
git diff --check
git status --short --branch
```
Expected: check exits 0, build exits 0, diff check clean, status contains only intended client + docs files. No env/db/build-output/screenshot files tracked.

- [ ] **Step 12: Manual smoke**

Start the dev stack. With PM Agent active in a chat, type `/` and confirm weekly-report-analysis + competitive-analysis appear. Select competitive-analysis, type `gpt vs claude vs gemini`, Enter, and confirm the analysis run begins. Switch to a non-PM agent and confirm only that agent's skills (or `/skills` alone) appear.

- [ ] **Step 13: Review checkpoint**

Review the full diff against the design spec. Confirm no backend/proxy/storage/agent/skill change. Do not commit, push, or create a PR unless explicitly requested.
