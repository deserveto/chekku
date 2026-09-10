# QA Web Agent Evaluation Design

## Goal

Add one on-demand Mastra eval for `qa-web-agent` that exercises its critical browser QA path and produces a scored result from the pipeline. The eval must be deterministic enough to run locally and in CI-like environments without depending on a third-party website.

The scope is intentionally one agent and one critical-path scenario:

1. start a local read-only QA fixture;
2. ask the agent to inspect the page and verify the expected facts;
3. capture the browser trajectory and final report;
4. score both execution and response quality;
5. print a compact per-case score summary and fail on critical gates.

## Repository and Mastra constraints

- The repository is already on `@mastra/core@1.50.1`, which exposes `createScorer` and `runEvals`; no Mastra dependency upgrade is needed.
- The plain `qaWebAgent` instance is the eval target. The durable wrapper is composition-root infrastructure and is not the unit under evaluation.
- The eval remains opt-in. It must not be added to the regular `npm test`, `npm run check`, or production startup path.
- The eval runner must dynamically import the agent only after checking required LLM and browser prerequisites, so missing local configuration produces an actionable message rather than an import-time model error.

## Critical-path fixture

The eval owns a small local HTTP fixture. It serves a public page with stable facts:

- page title: `Chekku QA Fixture`;
- main heading: `Checkout Smoke Test`;
- status text: `Ready for testing`;
- a `View pricing` link that resolves to `/pricing`;
- a pricing page with a stable heading.

The test prompt instructs the agent to navigate only within this fixture, verify those facts, click the pricing link, avoid submissions or mutations, and return a concise report with `Summary`, `Checks`, `Evidence`, and `Blockers` sections. The fixture is closed in `finally`, even when the agent or scorer fails.

This tests the agent's intended browser flow—navigation, inspection, link interaction, evidence gathering, and concise reporting—without making the score depend on DNS, a remote site's markup, authentication, or external data.

## Golden reference

The case stores a versioned golden response beside its prompt. It is a reference for the facts and reporting shape, not an exact string-match target. It contains:

- a passing summary;
- one check for each required page fact and the pricing navigation;
- evidence grounded in the fixture;
- `Blockers: None`.

The golden is reviewed as a structured reference and compared semantically by the judge scorer. Updating the fixture or task contract requires updating the golden in the same change.

## Scoring pipeline

The eval uses three scorers, with the first two acting as gates:

### 1. Browser trajectory gate

Deterministically extract the trajectory from the Mastra agent output and require successful, ordered calls to browser navigation, snapshot, click, and post-click snapshot. The scorer also checks fixture-origin URLs, `/pricing` navigation, and rejects unsafe mutation/evaluate browser tools. It returns `1` only when all required actions are present and successful; otherwise it returns `0` with the missing, failed, unsafe, or out-of-scope names in the reason. The extraction happens inside the scorer because Mastra 1.50.1 passes raw output to `gates`.

### 2. Report structure gate

Deterministically inspect the final text and require the four contract headings, substantive summary/checks/evidence/blockers sections, five PASS/FAIL check results, and all five expected check topics. Heading matching is line-based and case-insensitive to avoid accidental substring matches. The scorer returns `1` or `0` with an actionable reason.

### 3. Golden-reference LLM scorer

Use the configured OpenAI-compatible judge model to compare the task, fixture facts, golden reference, and agent output. Ask for JSON dimensions:

- `taskCoverage`: verified facts and navigation are represented;
- `evidenceAccuracy`: claims are supported by the fixture;
- `scopeSafety`: no mutation or out-of-scope navigation is claimed;
- `reportClarity`: the result is concise and operationally useful.

Combine the dimensions with weights `0.40`, `0.35`, `0.15`, and `0.10`. Record the score and reason, but keep the deterministic gates as the release-protection criteria. The LLM judge must be a separately configured model through the existing server model gateway; the agent's configured model is not hard-coded in the eval.

## Runner and operator experience

Add a dedicated command:

```bash
npm run eval:qa-web
```

The command runs only `agent/src/evals/qa-web/run.eval.ts` through the existing eval Vitest configuration. It should:

1. validate `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_DEFAULT_MODEL`;
2. validate that Playwright Chromium is available, explaining `npx playwright install chromium` when it is not;
3. start the local fixture;
4. run the single case with a fresh memory thread;
5. print case-level and aggregate scores, including gate verdicts;
6. close the fixture and browser resources.

The existing social-media eval command must be narrowed to its own file so adding this eval does not silently run unrelated evals. Documentation must list both opt-in commands and the required LLM/browser setup.

## Test plan

Unit tests cover the pure parts without an LLM or browser:

- golden case construction and fixture URL injection;
- report text extraction from supported Mastra output shapes;
- strict report-structure pass/fail behavior;
- trajectory gate behavior for complete, missing, and failed tool calls;
- score clamping and weighted judge aggregation.

The `.eval.ts` runner is the on-demand integration test. It is expected to skip/fail early with a clear prerequisite error when local LLM credentials or Chromium are not configured. A live scored run is verification evidence when those prerequisites are available.

## Non-goals

- evaluating every QA workflow or every agent;
- testing the durable workflow wrapper;
- adding a remote website dependency;
- persisting eval results into application production storage;
- adding eval execution to the regular test or deployment gates;
- asserting exact wording or exact tool-call order beyond the critical actions.
