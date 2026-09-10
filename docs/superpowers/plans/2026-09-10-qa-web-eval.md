# QA Web Agent Eval Implementation Plan

> **Execution note:** Follow this plan in the isolated `feat/eval-qa-web` worktree. Keep the eval opt-in and do not modify production agent behavior.

## 1. Lock the operator surface

Files:

- `package.json`
- `vitest.eval.config.ts`
- `README.md`
- `docs/OPERATIONS.md`
- `AGENTS.md`

Changes:

1. Add `eval:qa-web` with a file filter so it runs only the QA Web eval.
2. Narrow `eval:social-strategy` to its existing eval file so eval commands remain one-agent/one-eval.
3. Keep the generic eval config's `.eval.ts` include and on-demand behavior.
4. Document the QA Web command, LLM variables, Chromium prerequisite, local fixture behavior, scorer output, and the fact that evals are not part of the regular check.
5. Correct stale social-eval wording that says the eval is threadless/storageless; the runner uses in-memory storage and fresh memory threads.

## 2. Add the deterministic QA fixture and golden case

Files:

- `agent/src/evals/qa-web/fixture.ts`
- `agent/src/evals/qa-web/cases.ts`

Changes:

1. Implement a small `node:http` server with `/` and `/pricing` routes, fixed HTML, and an explicit close function.
2. Export the fixture facts so scorers and the judge prompt share one source of truth.
3. Export one case factory that injects the fixture base URL into the task prompt.
4. Store the Indonesian critical-path prompt and a versioned English/Indonesian-compatible golden report in the case module. The golden describes facts and report quality, not exact wording.

## 3. Write pure scorer tests first

File:

- `agent/src/evals/qa-web/scorers.test.ts`

Tests:

1. Extract final text from plain strings, Mastra 1.50.1 message content, UI-message parts, and unknown shapes.
2. Accept a complete report and reject missing headings, empty evidence, or too-short output.
3. Accept a trajectory containing successful `browser_goto`, `browser_snapshot`, and `browser_click` calls.
4. Reject missing required actions, failed tool results, and non-browser trajectories.
5. Clamp and verify the weighted golden-judge score.
6. Verify the committed golden report itself satisfies the structure contract.

Run the new test file before implementing the scorers to confirm the tests fail for the expected missing-module reason.

## 4. Implement the scorer module

File:

- `agent/src/evals/qa-web/scorers.ts`

Implementation:

1. Reuse the defensive output extraction pattern already proven by the social eval, with QA-specific names.
2. Use line-based, case-insensitive heading matching and explicit non-empty section checks.
3. Define the deterministic trajectory scorer as an agent scorer with a preprocess step that calls `extractTrajectory`; Mastra 1.50.1 passes raw agent output to `gates`, so extraction must happen inside the scorer.
4. Require successful navigation, pre-click inspection, click, post-click inspection, ordered execution, same-origin URLs, `/pricing` navigation, and no unsafe mutation/evaluate tools.
5. Define the LLM judge schema with coverage, evidence accuracy, scope safety, clarity, and missing points; include a compact trajectory summary and compute the documented weighted score.
6. Keep the judge instructions grounded in the case facts and tell the judge not to reward unsupported claims or exact wording.

Run the scorer unit tests and the agent workspace typecheck.

## 5. Implement the on-demand Mastra runner

File:

- `agent/src/evals/qa-web/run.eval.ts`

Implementation:

1. Check LLM variables before dynamically importing `qa-web-agent`, avoiding import-time model failures.
2. Check the configured browser executable or Playwright's Chromium executable path and provide the install command when absent.
3. Start the local fixture and create the one case.
4. Build the judge model through the existing OpenAI-compatible gateway.
5. Register the plain `qaWebAgent`, scorers, and `InMemoryStore` on a lightweight `Mastra` instance.
6. Run the case through `runEvals` with a fresh `qa-web-agent-evals` memory thread, deterministic gates, and a tracked golden threshold.
7. Print per-scorer results, aggregate scores, gate/threshold status, and the final verdict.
8. Close the fixture and browser in `finally` and fail only for missing execution/structure gates or an unevaluated case.

Run the eval command once. If this environment still lacks LLM credentials or Chromium, verify the actionable preflight error and record the limitation rather than fabricating a live score.

## 6. Verification and handoff

Run, in order:

1. QA Web scorer unit tests.
2. Social scorer unit tests to ensure shared Mastra behavior is unaffected.
3. Agent workspace typecheck.
4. Root `npm run check`.
5. Root `npm run build`.
6. The opt-in QA Web eval command, when prerequisites are available.

Inspect the diff, commit focused changes, push `feat/eval-qa-web`, and open a PR against `main` with the baseline results and any environment-only limitation clearly stated.
