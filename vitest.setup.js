import { TextEncoder, TextDecoder } from 'node:util';
import { vi } from 'vitest';

if (!globalThis.TextEncoder) globalThis.TextEncoder = TextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = TextDecoder;

// `agent/src/config/env.ts` loads agent/.env unconditionally, so a real
// deployment value (WEB_URL=https://app.example.com) would leak into assertions
// about the agent's CORS origin and fail the suite on any machine that has
// actually been deployed. dotenv never overrides a variable already present in
// process.env, and setup files run before test modules import, so pinning the
// default here keeps the suite deterministic while still honouring an explicit
// shell override.
process.env.WEB_URL ??= 'http://localhost:3000';

// The agent composition root resolves each code-defined agent's model lazily
// through `getServerModel()`, which throws unless LLM_BASE_URL, LLM_API_KEY,
// and LLM_DEFAULT_MODEL are all set. On a developer machine agent/.env supplies
// real values, but CI checks out no dotenv — composition-root tests that touch
// model resolution (e.g. getToolsForExecution in task-signals-wiring.test.ts)
// then fail with "No model configured". Pinning inert defaults here keeps the
// suite deterministic everywhere; an explicit shell override still wins, and
// dotenv never overwrites these process.env values afterwards.
process.env.LLM_BASE_URL ??= 'http://localhost:4000/v1';
process.env.LLM_API_KEY ??= 'test-key';
process.env.LLM_DEFAULT_MODEL ??= 'test-model';

// The agent composition root (`agent/src/mastra/index.ts`) constructs the Mastra
// storage backend at module load. LibSQL (the previous backend) created a local
// file silently; PostgresStore opens a network connection on init(), which fails
// with ECONNREFUSED during unit tests (no Postgres container is running). Tests
// that import the `mastra` instance need it for agent/route structure and Mastra
// calls several storage methods during construction, so substitute @mastra/pg's
// PostgresStore with @mastra/core's in-memory store. This mirrors the harmless
// offline behaviour the test suite relied on under LibSQL.
vi.mock('@mastra/pg', async () => {
  const { InMemoryStore } = await import('@mastra/core/storage');
  return {
    PostgresStore: class {
      constructor(opts) {
        const store = new InMemoryStore({ id: opts?.id });
        // Real @mastra/pg 1.15.0 does not implement the threadState
        // domain, but InMemoryStore does natively. Drop it so the mock
        // mirrors production and the composition root's backfill is
        // load-bearing: removing the backfill from index.ts must fail the
        // wiring tests instead of silently passing on the mock's domain.
        if (store.stores) delete store.stores.threadState;
        return store;
      }
    },
  };
});
