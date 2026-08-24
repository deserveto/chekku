# LLM Thread Titles for Main Agents — Design

Date: 2026-08-24
Status: Approved (brainstorming complete)

## Context

Chekku names chat threads by truncating the first prompt to 52 characters
server-side at run start (`buildThreadTitle` in
`agent/src/mastra/runs/execute.ts`, called from `ensureFirstTurnThread` in
`agent/src/mastra/routes/runs.ts`). The result is a choppy prefix like
"tolong buatkan saya konten tentang perkembangan AI di Indone…" rather than a
descriptive title.

Mastra (installed `@mastra/core` 1.49 / `@mastra/memory` 1.22) ships native
thread title generation: `Memory({ options: { generateTitle: true } })`. After
the first assistant response, the agent's LLM generates a short title from the
first user message (default instructions: ≤80 characters, summary of the
message, no quotes or colons). Generation is asynchronous relative to the
response stream, failures are logged and swallowed (never fatal), and it only
fires when the thread has no title yet, so manual renames always win.

Verified Mastra gating (dist source, `chunk-OE4IEL7C.js:48585`): title
generation runs inside the memory-update phase after the stream loop only when
`shouldGenerate && !thread.title && messages.length >= minMessages` — i.e.
once per thread, first turn, and only when no title exists.

## Goal

The five main (chat-facing) agents get LLM-generated thread titles:

- `main-agent`
- `qa-web-agent`
- `qa-android-agent`
- `pm-agent`
- `social-media-supervisor-agent`

Sub-agents (`social-media-content-writer`, `social-media-strategist-agent`,
`visual-content-agent`) keep default behavior (no title generation) — their
threads are delegation artifacts, and the Visual Content Agent is invoked by
workflows where a title call would be pure noise.

## Non-goals

- No change to stored-agent memory (hydrated via `@mastra/editor` internals;
  separate path, may be revisited later).
- No custom title model, no new env vars. Title generation uses the agent's
  own model through the existing OpenAI-compatible gateway
  (`getServerModel()`), with Mastra's default title instructions.
- No client-side title generation. The browser never renames threads.
- No regeneration on later turns and no overwrite of manual renames.

## Chosen approach — Mastra-native (A)

Enable `generateTitle: true` on the five main agents' Memory and stop
pre-setting a truncated-prompt title at run start. The alternative (B: keep
the truncated title and overwrite it with an LLM title after run completion
via a custom server call) was rejected: it duplicates what Mastra already
does, adds custom code on the run surface, and the completion-time client
refresh could miss the late title write.

### Change 1 — `createAgentMemory` opt-in

`agent/src/mastra/processors/context-limit.ts`:

```ts
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

Default remains off, so sub-agents and any other existing call sites are
unchanged. The five main agents change to
`memory: createAgentMemory({ generateTitle: true })`.

### Change 2 — untitled first-turn thread creation

`agent/src/mastra/runs/execute.ts`:

- `buildThreadTitle` is deleted.
- `ensureFirstTurnThread` keeps creating the Memory thread record before the
  202 response (the thread is still listed the moment the prompt is sent) but
  without a `title` — an empty title is exactly Mastra's trigger for
  generating one at first-turn completion.
- The `MemoryAccess` interface drops `title` from `createThread` params.

`agent/src/mastra/routes/runs.ts` updates the stale comment
("titled from the prompt") accordingly. `parseStartRunRequest` is untouched —
`run.prompt` is still derived for attachment-only turns because run summaries
carry it (the client synthesizes the user turn from it when attaching to a
running run); only its use as a title source disappears.

### Client behavior — no code change

`normalizeThread` (`client/src/lib/memory-threads.ts:111-114`) already falls
back to `'New conversation'` for untitled threads, so the sidebar shows that
until the first turn completes. Title generation is awaited inside the run's
memory-update phase before the run reaches `completed`, so the existing
completion-time thread refresh surfaces the LLM title. Manual
`renameThread` still works and permanently suppresses regeneration (title is
non-empty).

## Edge cases

- **Cancelled / watchdog-failed first run:** the stream aborts before the
  memory-update phase, so no title is generated. The thread stays untitled;
  the next successful turn satisfies `!thread.title` again and generates the
  title then. Self-healing, no special handling.
- **Duplicate start (409 attach):** the attaching client synthesizes the user
  turn from `run.prompt`; sidebar shows `New conversation` until the title
  lands. Acceptable.
- **Workflow `.generate()` calls** (`weekly-social-drafts`,
  `generate-social-post-visual`): pass no memory thread/resource, and Mastra
  gates title generation on `resourceId && thread`, so workflows never
  trigger title calls.
- **Title generation failure:** Mastra logs and swallows; thread keeps the
  `New conversation` fallback. Never fatal to the run.
- **Attachment-only first turn:** title is generated from the message text
  the model sees (prepared text blocks with filename labels); the previous
  filename-as-title behavior simply goes away.

## Tests

- `agent/src/mastra/runs/execute.test.ts`: `ensureFirstTurnThread` now
  creates an untitled thread; delete the `buildThreadTitle` suite and title
  assertions.
- `agent/src/mastra/processors/context-limit.test.ts`: `createAgentMemory()`
  leaves title generation off by default; the opt-in sets it (assert through
  whatever the `Memory` instance exposes — merged thread config or an
  equivalent construction snapshot).
- Agent configuration tests: the five main agents enable title generation,
  the three sub-agents do not (existing `both-agents.test.ts` /
  per-agent suites extended, or one focused config test).
- `agent/src/mastra/routes/runs.test.ts`: update any first-turn title
  expectations to untitled creation.

## Documentation

- `AGENTS.md` "Agent run lifecycle": rewrite the first-turn-title invariant —
  thread record is created untitled at run start (instant listing), Mastra
  generates the LLM title (≤80 chars) at first-turn completion for the five
  main agents, manual rename wins, sub-agents never titled.
- `docs/ARCHITECTURE.md` (line 461, "First-turn titles"): same correction.
- No env vars change, so `README.md` needs no update. Check
  `docs/OPERATIONS.md` line 195 ("persisted thread title" phrasing): the
  filename sanitization itself stays — only wording that implies the filename
  becomes the title needs adjusting if present.
