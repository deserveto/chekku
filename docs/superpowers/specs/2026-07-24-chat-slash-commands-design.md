# Chat Slash-Command Picker Design

## Status

Approved during brainstorming on 2026-07-24. Ready for implementation planning.

This feature is client-only. It adds a chat slash-command picker that surfaces
an agent's skills and lets the user invoke them by inserting a canonical prompt.
It does not change agents, the proxy, storage, MCP registries, skills, or
environment variables.

## Goal

When a user types `/` at the start of the chat input, show a keyboard-navigable
menu of the active agent's user-invocable skills. Selecting a skill inserts
`/<skill-name> ` into the input; the user finishes the arguments and presses
Enter to send. The prompt flows through the existing `sendMessage()` path and
the agent routes it server-side, exactly as it does today for natural-language
requests.

Ship `/competitive-analysis` as the primary named command (the reviewer's
request) plus `/skills`, a reserved command that shows the full skill catalog.
Future skills appear automatically with no client edits.

## Context

`weekly-report-analysis` and `competitive-analysis` are already inline Mastra
skills (`createSkill()`, `user-invocable: true`) on `pmAgent`. The PM agent
already routes `/competitive-analysis` and equivalent natural-language requests
server-side. Web search (`search_web`) and web fetch (`read_web_page`) are
already bound and budget-enforced. So the capability exists; this feature only
adds a discoverable client entry point.

Mastra **natively exposes skills over HTTP**: `GET /api/agents/{agentId}/skills`
(implemented by `@mastra/client-js` `listSkills()`), proxied through the
existing catch-all `client/src/app/api/agent/[...path]/route.ts`. The client
currently fetches agents (`listAllAgents`) but never skills. There is no
existing slash-command or autocomplete logic in the chat composer.

## Selected Approach

Client command picker with dynamic skill data from the native endpoint.

Rejected alternatives:

- Static client registry of skills: drifts from server when skills are added;
  violates the "future skills" requirement.
- Extend the stream transport with a skill-id field: touches client-js, the
  proxy, and the agent server; breaks the "single composition root" invariant
  for no real benefit, since prompt routing already works.

## Architecture

### Data source

New client module `client/src/lib/agent-skills.ts` exposes:

```ts
export interface AgentSkillSummary {
  name: string;
  description?: string;
  userInvocable?: boolean;
}

export async function listAgentSkills(agentId: string): Promise<AgentSkillSummary[]>;
```

It calls `GET /api/agent/api/agents/{encodeURIComponent(agentId)}/skills` through
the same-origin proxy. It returns user-invocable skills only, sorted by name.
A module-level cache keyed by `agentId` avoids refetching within a session; the
cache is invalidated when the active agent changes.

The exact response shape of the native endpoint must be verified at
implementation time (read one live response). The module normalizes whatever the
endpoint returns into `AgentSkillSummary` and never leaks unknown fields to the
UI.

### Command menu component

New `client/src/components/chat/command-menu.tsx`. A presentational listbox
popover:

- `role="listbox"`, each option `role="option"` with `id`, `aria-selected`,
  driven by `aria-activedescendant` on the container.
- Props: `commands` (the filtered list), `activeIndex`, `onSelect(name)`.
- Pure / stateless: navigation state lives in `ChatStudio`.
- Positioned above the textarea via CSS (absolute, anchored to the composer).
- Renders one reserved `/skills` row plus one row per skill, each showing the
  command slug and description.

### ChatStudio integration

State additions near `chat-studio.tsx:91`:

```ts
const [commandOpen, setCommandOpen] = useState(false);
const [commandIndex, setCommandIndex] = useState(0);
const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
```

Trigger detection in the `onChange` handler (`chat-studio.tsx:730`): the picker
opens when the trimmed input starts with `/`. The filter is the text after the
leading `/`. `/skills` (exact) shows the full unfiltered catalog; any other
prefix filters skills by name (case-insensitive substring).

Keyboard in `keyDown` (`chat-studio.tsx:436`): when `commandOpen`, intercept
`ArrowUp` / `ArrowDown` (wrap-around navigation), `Enter` and `Tab` (select and
prevent default), and `Escape` (close). These run **before** the existing
Enter→send branch so a command selection never accidentally sends. Enter→send
fires only when the picker is closed.

Selection handler: `setInput('/' + name + ' ')`, close the picker, reset index,
keep focus in the textarea with the caret at the end.

Skill fetching: a `useEffect` on `agentId` calls `listAgentSkills(agentId)` and
stores the result. Non-PM agents with no skills keep the picker usable (it shows
only `/skills`, which itself lists nothing).

### Dispatch

No new transport. Selecting `/competitive-analysis` produces the input
`/competitive-analysis `; the user types `gpt vs claude vs gemini` and presses
Enter. `sendMessage('/competitive-analysis gpt vs claude vs gemini')` flows
through the existing chain (`chat-studio.tsx:336` → `agent.stream`). The PM
agent routes it via its base instructions. This is identical to typing the
command by hand today; the picker only makes it discoverable.

### Out of scope

- No new backend route, agent, MCP, storage, or environment variable.
- No change to skill instructions or server-side routing.
- No multi-agent command broadcast; commands are scoped to the active agent.
- No persistence of recent commands or favorites in this release.

## Accessibility

The listbox follows WAI-ARIA combobox/listbox patterns: the textarea retains
`role="combobox"` semantics conceptually, the menu is `role="listbox"`, options
are `role="option"`, and `aria-activedescendant` tracks the highlighted option.
Keyboard-only operation is the primary path (mouse click is secondary). Focus
never leaves the textarea while the menu is open.

## Testing

Regression-first TDD with Vitest and React Testing patterns already in the
client.

`agent-skills.test.ts`:

- fetch wrapper calls the correct proxied URL for a given agentId;
- returns user-invocable skills sorted by name;
- caches per agentId and refetches when agentId changes;
- returns `[]` on fetch failure without throwing (picker degrades to `/skills`
  only).

`command-menu.test.tsx`:

- renders `/skills` plus one row per skill;
- `aria-activedescendant` reflects `activeIndex`;
- `onSelect` fires with the chosen skill name;
- renders nothing when `commands` is empty and `/skills` is the only entry.

`chat-studio` behavior (extend existing tests or add focused ones):

- leading `/` opens the picker; non-leading `/` does not;
- typing `/comp` filters to `competitive-analysis`;
- ArrowUp/ArrowDown move the highlight with wrap-around;
- Enter while open selects (does not send); Enter while closed sends;
- Escape closes without inserting;
- selecting `/competitive-analysis` sets the input to `/competitive-analysis `.

`ui-structure.test.ts`:

- update the assertion that bans a generic "suggestion grid" — this is a command
  menu, a distinct, intentional component. Assert the command menu module exists
  and the old suggestion-grid pattern is still absent.

## Documentation

Update:

- `README.md` — mention `/` opens skill commands in chat; example
  `/competitive-analysis gpt vs claude vs gemini`.
- `docs/ARCHITECTURE.md` — note the chat composer exposes agent skills via a
  command picker backed by the native skills endpoint.
- `docs/OPERATIONS.md` — `/` command usage and that skills come from the active
  agent.

## Completion Verification

Before claiming completion:

- `npm run check` passes.
- `npm run build` passes.
- `git diff --check` clean.
- Manual: with PM Agent active, type `/`, see weekly-report-analysis and
  competitive-analysis; select competitive-analysis, type products, Enter, and
  see the analysis run; switch to a non-PM agent and confirm only that agent's
  skills (or `/skills` alone) appear.

## Non-Goals

- No file-based workspace-skills migration (inline `createSkill` is the approved
  pattern; see the related competitive-contract-hardening spec).
- No client-side persistence of command history.
- No streaming/real-time skill updates; skills are fetched per agent change.
