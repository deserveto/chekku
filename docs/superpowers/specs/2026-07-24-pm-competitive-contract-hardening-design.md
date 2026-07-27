# PM Competitive Contract Hardening Design

## Status

Approved during live validation on 2026-07-24. Live validation proved that
`processInputStep`'s `activeTools` return does not reliably bind the configured
OpenAI-compatible gateway, so the deterministic hard gate was moved to
tool-execute time. The implementation now uses two layers:

1. `withCompetitiveResearchBudget` wraps `search_web`, `read_web_page`, and
   competitive save. It enforces the 3/8/1 per-run attempted-call caps at
   execute time (gateway-independent), counts failed attempts, latches `Web
   Reader is not configured.` terminal, and rejects over-budget calls with
   fixed errors. This is the deterministic hard gate.
2. `competitive-research-guard` remains first in `inputProcessors` as an
   advisory layer that injects fixed safe incomplete-branch guidance after
   terminal Reader configuration failure. It does not replace the
   execute-level hard gate.

## Problem

The configured Web Reader passes its live smoke test, but a manual PM Agent run
for `GPT vs Claude vs Gemini` exposed instruction drift:

- PM Agent invoked `search_web` four times despite the three-call limit;
- six Reader calls succeeded and two failed, leaving fewer than five evidenced
  competitors;
- the response used the completed-report title instead of the required
  incomplete title;
- it supplied uncited general-knowledge claims for unevidenced products;
- it correctly did not call the save tool or emit `Saved analysisId:`.

Earlier validation with an empty Reader key also showed eight repeated Reader
calls after the first terminal configuration error. Current prompt-only limits
therefore protect persistence through the save schema but do not reliably bound
live tool execution or final prose.

## Goal

Keep PM Agent's direct skill architecture while adding deterministic per-run
tool caps and making the incomplete-report branch explicit enough for reliable
model execution.

## Selected Approach

Use a hybrid guard and prompt design.

Add a PM-only input-step processor named `competitive-research-guard`. It
examines completed step tool calls and controls tools available on the next
step. It does not modify reusable SearXNG, Web Reader, or Garage tools.

Strengthen `competitive-analysis` instructions with an evidence inventory and
a mandatory pre-draft completion gate. Persistence validation remains the final
deterministic complete-report boundary.

Rejected alternatives:

- Prompt-only hardening remains vulnerable to observed budget drift.
- Tool-local counters require run-scoped mutable state inside reusable tools and
  couple those tools to one agent workflow.
- A dedicated Mastra workflow would enforce more stages but replaces the
  approved direct-agent architecture and expands scope substantially.

## Processor Design

`competitive-research-guard` runs before the existing context limiter and
character-budget guard. The character guard remains last.

For every model step, the processor counts prior attempted calls by tool name
from completed step results. Failed calls count because their tool calls still
consumed provider and agent steps.

It removes tools from the next step when these limits are reached:

- `search_web`: 3 attempts;
- `read_web_page`: 8 attempts;
- `save_competitive_analysis_to_garage`: 1 attempt.

When a prior `read_web_page` tool error contains the fixed safe configuration
failure `Web Reader is not configured.`, the processor removes
`read_web_page` immediately, regardless of remaining slots. It also adds a
fixed transient system instruction requiring the incomplete branch. It does not
include URL, key, headers, raw provider data, or diagnostics.

The processor preserves every unrelated active tool and does not alter
successful tool outputs. PM Agent remains the only consumer.

## Skill Contract

Research proceeds through an explicit evidence inventory:

1. Record a product as evidenced only after one successful official or primary
   `read_web_page` result during the current run.
2. Before drafting, count the evidenced anchor and evidenced competitors.
3. Enter the complete branch only with one evidenced anchor plus five to seven
   evidenced competitors.
4. Otherwise enter the incomplete branch without trying to fill gaps from model
   knowledge or search snippets.

The incomplete branch must:

- start with exact H1 `# Incomplete Competitive Analysis: <anchor product>`;
- describe only claims supported by successful page reads from the current run;
- list unevidenced products under missing evidence without feature, pricing,
  positioning, or comparison claims;
- state safe tool failures and useful user action when relevant;
- omit completed-report confidence language for unsupported products;
- never call `save_competitive_analysis_to_garage`;
- never emit `Saved analysisId:`.

After `Web Reader is not configured.`, PM Agent must stop Reader calls
immediately and return incomplete work. Availability, timeout, and individual
page failures may use remaining Reader slots for another official source or an
agent-selected replacement candidate.

## Testing

Follow regression-first TDD.

Processor tests prove:

- the fourth search tool is unavailable after three attempts;
- the ninth Reader tool is unavailable after eight attempts;
- failed attempts count toward limits;
- the second Reader tool is unavailable after a terminal configuration error;
- nonterminal Reader errors do not prematurely remove the tool;
- the second save tool is unavailable after one attempt;
- unrelated tools remain available;
- the terminal-error instruction contains only fixed safe text.

Skill tests prove explicit instructions for:

- terminal configuration stop;
- evidence inventory and pre-draft count;
- exact incomplete H1;
- no general-knowledge or search-snippet fallback claims;
- no incomplete save call or `Saved analysisId:` receipt.

PM Agent tests prove processor order remains:

```text
competitive-research-guard
token-limiter
char-budget-guard
```

Run the focused tests first, then `npm run check`, `npm run build`, and
`git diff --check`. Repeat the live manual prompt after restart when provider
availability permits.

## Documentation

Update architecture and operational documentation to distinguish deterministic
tool availability caps from model-driven evidence synthesis. Keep all existing
provider, storage, namespace, route, and MCP registry boundaries unchanged.

## Non-Goals

- No new provider, crawler, recursive link following, browser fallback, or PDF
  support.
- No Web Reader error-message or credential changes.
- No storage schema, route, client UI, or report migration changes.
- No claim that output prose is fully deterministic; persistence eligibility
  and tool caps are deterministic, while synthesis remains model-driven.
