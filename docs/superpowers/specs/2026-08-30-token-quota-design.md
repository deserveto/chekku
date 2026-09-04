# Per-User Daily Token Quota — Design

Date: 2026-08-30
Status: Approved (brainstorming complete)

## Context

Chekku has no per-user token accounting. Any authenticated user can prompt the
agent server without bound, and LLM token usage (which the OpenAI-compatible
gateway already returns inside Mastra stream chunks) is discarded: the
`step-finish` and `finish` chunks of `agent.stream()`'s `fullStream` carry
`totalUsage` (`inputTokens` / `outputTokens` / `totalTokens`), but
`chunkToRunEvent` in `agent/src/mastra/runs/execute.ts` maps only
`text-delta`, `tool-call`, `tool-result`, `tool-error`, `error`, and
`tripwire` chunks, so usage never reaches the run surface.

The user identity key on the agent server is `resourceId`: the Next.js
`/api/runs` seam (`client/src/app/api/runs/[[...path]]/route.ts`) derives it
from the Better Auth session (`session.user.id`) on every request and discards
any client-supplied value. All quota accounting keys on `resourceId`.

Market research (free-tier LLM APIs, 2026): Gemini Flash free tier supports
20–1,500 requests/day (effectively ~1.5–3M tokens/day), Groq's free tier
realistically lands in the low hundreds of K tokens/day, Mistral's free tier is
~1M tokens/**month** (~33K/day). One Chekku agent turn is expensive —
multi-step tool use re-sends context per step, commonly 10K–100K+ tokens per
turn — so the shipped default sits mid-range at **500,000 tokens/day**
(≈ 5–50 agent turns/day).

## Goal

- Track token usage per user (`resourceId`), per UTC day, across all agents.
- Block new prompting when the daily limit is reached.
- Limit configurable globally via a server-side env var.

## Non-goals

- No durable usage persistence (no SQL, no Garage). Counters are in-memory,
  matching the run-registry and competitive-research-budget philosophy.
- No per-user overrides, no tiers, no admin UI, no usage badge/dashboard —
  quota state is visible only through the blocked-prompt error message.
- No gating or accounting of scheduled workflows (`weekly-social-drafts`,
  `repurpose-social-post`, `generate-social-post-visual`) — they are
  system-initiated, not user prompting, and have no user run.
- No metering of the image generation model (`LLM_IMAGE_MODEL` has no token
  metering in scope); only the Visual Content Agent's orchestration tokens
  count, like any other agent step.
- No client code changes — the existing inline error path in ChatStudio
  already surfaces run-start failure messages verbatim.

## Chosen approach — in-memory tracker (A)

New module `agent/src/mastra/runs/token-quota.ts` with a `TokenQuotaStore`:
`Map<resourceId, { day, used }>`, process lifetime, single instance (the agent
server is single-instance by invariant). Rejected alternatives:

- **B: durable Postgres table in `chekku_agent`** — accurate and restart-safe,
  but it would be the first hand-written DDL in the agent workspace (all DDL
  today is owned by `@mastra/pg` and Better Auth's CLI), requiring a new
  migration ownership path. Heavier than the stated scope.
- **C: counter object in Garage via `@chekku/storage`** — Garage v2.3 has no
  cross-process conditional-write safety; read-modify-write races on a hot
  counter make it the wrong tool.

If durability is ever needed, the store stays behind a narrow interface
(`assertQuota`, `consume`, `getUsage`) so a Postgres-backed implementation can
replace it without touching call sites. A monthly period is likewise a
constant inside the store, not a call-site concern.

## Details

### Config (`agent/src/config/env.ts`)

New server-only env var `TOKEN_DAILY_LIMIT`:

- integer ≥ 0
- default `500000`
- `0` disables quota enforcement entirely (unlimited)

### Quota store (`agent/src/mastra/runs/token-quota.ts`)

- `getUsage(resourceId)` → `{ used, limit }`; lazy day rollover: an entry whose
  `day` (UTC `YYYY-MM-DD`) is not today resets `used` to 0 on first access.
- `assertQuota(resourceId)` → throws `TokenQuotaExceededError` when
  `limit > 0 && used >= limit`.
- `consume(resourceId, tokens)` → adds to the current-day entry.
- Error carries `{ used, limit }` so the route can format the message.

### Enforcement (`startRunRoute`, `agent/src/mastra/routes/runs.ts`)

Quota check inserted after `resolveAgent` (so unknown agents still 404 first)
and **before** `ensureFirstTurnThread` and `createRun` — blocked users must not
create thread records, and the cheapest deterministic rejection happens before
registry capacity logic. `TokenQuotaExceededError` maps to **HTTP 429** with a
fixed bounded message:

```
Daily token limit reached (500,000 of 500,000 tokens used). Resets at midnight UTC.
```

(actual figures interpolated). This mirrors the existing `RunCapacityError`
handling shape. Client behavior needs no change: `readErrorResponse` in
`client/src/lib/agent-runs.ts` parses the JSON `error` field and ChatStudio
appends it to the assistant placeholder inline.

### Usage recording (`runExecution`, `agent/src/mastra/runs/execute.ts`)

Handle the two currently-discarded chunk types:

- `step-finish` → consume the **delta since the last consumed step** from the
  chunk's `totalUsage` (guards against providers/SDK versions that report
  cumulative step usage).
- `finish` → final reconciliation: consume `finishTotal − recordedSum` when
  positive. Catches undercount (e.g. sub-agent delegated usage surfacing only
  in the whole-run total); never double-counts.

Failed and cancelled runs keep whatever was consumed — the tokens were spent.

### What counts

- `totalTokens` (input + output, cached input included) summed across all
  agents (code-defined and stored), all steps, sub-agent delegation usage when
  it surfaces in the parent stream, per `resourceId` per UTC day.
- Known boundary (unchanged posture): agent run routes are
  `requiresAuth: false`; quota keys on the `resourceId` the Next.js seam
  injects from the session. Direct agent-server network access bypasses quota
  the same way it bypasses every other client seam today.

### Restart semantics

In-memory counters die with the process: a restart gives users a fresh daily
quota for the rest of the day. Accepted limitation, bounded by the daily reset.

## Testing (Vitest)

- `token-quota.ts` unit tests: lazy day rollover, boundary (`used == limit`
  blocks), `0` = unlimited, error payload shape.
- `runExecution` loop tests with fake chunks: step-finish delta consumption,
  cumulative-reporting variant, finish reconciliation (positive and zero
  delta), cancelled run keeps consumption.
- Route tests: 429 ordering (after 404 for unknown agent, before thread
  creation and capacity checks), message shape, blocked user gets no thread
  record.

## Documentation

- `README.md` env table: `TOKEN_DAILY_LIMIT`.
- `AGENTS.md` invariants: env var, enforcement point and ordering, in-memory
  restart semantics, what is counted/not counted.
