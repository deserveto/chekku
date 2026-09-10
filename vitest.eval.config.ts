import { defineConfig } from 'vitest/config';

/**
 * On-demand eval runner config (agent evals, N11_2) — kept separate from
 * vitest.config.ts on purpose:
 *
 * - `include` matches only `*.eval.ts` files, and the main config matches
 *   only `*.test.ts` — so evals never run inside `npm test` / `npm run
 *   check` / CI, and unit tests never run under this config.
 * - Deliberately NO setupFiles: vitest.setup.js pins inert LLM_* defaults
 *   (`??=`) that would shadow the real agent/.env gateway values this eval
 *   needs, and mocks PostgresStore for composition-root imports this eval
 *   never performs (each eval registers its target on its own in-memory Mastra
 *   instance instead).
 * - Long timeout: each case is a live agent turn plus judge calls.
 *
 * Run one agent eval at a time: npm run eval:social-strategy or npm run eval:qa-web
 */
export default defineConfig({
  test: {
    include: ['agent/src/evals/**/*.eval.ts'],
    exclude: ['**/node_modules/**', '**/node_modules'],
    environment: 'node',
    testTimeout: 900_000,
    // The eval IS its score report: let console.log pass straight through
    // instead of being intercepted into per-test blocks that only surface
    // on failure.
    disableConsoleIntercept: true,
  },
});
