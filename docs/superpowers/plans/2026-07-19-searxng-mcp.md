# Built-in SearXNG MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one secure built-in `searxng` MCP capability with bounded `search_web` access for PM Agent and selectable stored agents, backed by local or external server-owned SearXNG.

**Architecture:** A focused HTTP client validates server-owned configuration, calls only fixed `/config` and `/search` paths, and normalizes bounded output. One reusable Mastra tool is registered directly on PM Agent and wrapped by an immutable in-process `MCPServer` for stored-agent hydration. Root Compose and launcher manage a pinned loopback-only local SearXNG service without exposing service secrets or search credentials to Next.js.

**Tech Stack:** TypeScript 6, Node.js 22.22+, Zod 3.25.76, Mastra 1.50.0, `@mastra/mcp` 1.14+, Vitest 4, Next.js 16, Bash, Docker Compose, SearXNG `2026.7.18-277d8469c`.

## Global Constraints

- Work only in `feat/searxng-mcp`, based on `origin/main`; local `main` and its three planning commits remain untouched.
- Follow `docs/superpowers/specs/2026-07-19-searxng-mcp-design.md` exactly.
- Keep `agent/src/mastra/index.ts` as the single Mastra composition root.
- Preserve all four existing code-defined agents, Memory, model gateway, thread ownership, identity, proxy methods, browser approvals, Telegram, email approvals, and PM report boundaries.
- Keep Garage MCP at exactly its unchanged five generic tools.
- Add no npm dependency; use Node `fetch`, Web Streams, `URL`, `AbortSignal`, and existing Zod/Mastra packages.
- Browser/model/stored-agent input never controls SearXNG endpoint, path, method, headers, credentials, package, command, environment, response format, timeout, or arbitrary URL.
- `search_web` is read-only, approval-free, idempotent, and open-world.
- Query limit: 1,024 UTF-8 bytes. Results: default 10, maximum 20. Page: 1-5. Timeout: 12 seconds. Upstream body: 2 MiB. Serialized output: 131,072 UTF-8 bytes.
- Local SearXNG is pinned to `docker.io/searxng/searxng:2026.7.18-277d8469c` and published only at `127.0.0.1:8888`.
- Use TDD for every behavior: add focused failure, observe failure, implement minimally, observe pass, then commit.
- Do not push, create a PR, delete branches/worktrees, or rewrite history without explicit user approval.

---

## File Structure

### New backend files

- `agent/src/mastra/searxng/config.ts`: parse the two server-owned application values and construct fixed endpoint paths.
- `agent/src/mastra/searxng/config.test.ts`: configuration, URL, and credential safety tests.
- `agent/src/mastra/searxng/client.ts`: capability cache, bounded HTTP transport, targeting validation, and response normalization.
- `agent/src/mastra/searxng/client.test.ts`: transport, limits, output, cache, and safe-error tests.
- `agent/src/mastra/tools/searxng-search.ts`: strict public schemas and reusable `search_web` Mastra tool.
- `agent/src/mastra/tools/searxng-search.test.ts`: schema, annotation, approval, and execution tests.
- `agent/src/mastra/mcp/searxng-mcp-server.ts`: immutable fixed MCP registry.
- `agent/src/mastra/mcp/searxng-mcp-server.test.ts`: registry and stored-agent hydration tests.

### New local-operation files

- `searxng/settings.yml`: tracked minimal SearXNG settings.
- `scripts/searxng-env.sh`: ignored secret/config-hash generation and safe agent-env rendering.

### Existing files to modify

- `agent/src/config/env.ts`, `agent/src/config/env.test.ts`: add only `SEARXNG_BASE_URL` and `SEARXNG_API_KEY`.
- `agent/src/agents/pm-agent.ts`, `agent/src/agents/__tests__/both-agents.test.ts`: bind `search_web` without changing PM report instructions.
- `agent/src/mastra/index.ts`, `agent/src/__tests__/agent-routes.test.ts`: register fixed MCP server.
- `client/src/server/agent-payload.ts`, `client/src/server/agent-payload.test.ts`: whitelist and round-trip both fixed MCP IDs.
- `client/src/app/api/agent/[...path]/route.ts`, `route.test.ts`: validate non-empty fixed subsets.
- `client/src/components/agents/agent-builder-page.tsx`, `client/src/lib/ui-structure.test.ts`: render separate fixed capability cards.
- `compose.yaml`, `scripts/dev.sh`, `scripts/dev.test.ts`, `.gitignore`: local service and launcher lifecycle.
- `.env.example`, `agent/.env.example`, `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`: public contract and invariants.

---

### Task 1: Server-Owned SearXNG Configuration

**Files:**
- Create: `agent/src/mastra/searxng/config.ts`
- Create: `agent/src/mastra/searxng/config.test.ts`
- Modify: `agent/src/config/env.ts:4-30`
- Modify: `agent/src/config/env.test.ts:5-67`

**Interfaces:**
- Produces: `SearxngConfigurationInput`, `SearxngConfiguration`, `parseSearxngConfiguration(input)`, and `searxngEndpoint(config, path)`.
- `parseSearxngConfiguration()` returns `undefined` only when `baseUrl` is empty.
- `searxngEndpoint()` accepts only literal path union `'config' | 'search'`.

- [ ] **Step 1: Add failing environment tests**

Add these assertions to `agent/src/config/env.test.ts`:

```ts
it('uses empty server-owned SearXNG defaults', () => {
  const value = loadEnv({});
  expect(value.SEARXNG_BASE_URL).toBe('');
  expect(value.SEARXNG_API_KEY).toBe('');
});

it('accepts only the two SearXNG application values', () => {
  const value = loadEnv({
    SEARXNG_BASE_URL: 'https://search.example.test/private/',
    SEARXNG_API_KEY: 'search-secret',
    SEARXNG_SECRET: 'must-be-ignored',
  });
  expect(value.SEARXNG_BASE_URL).toBe('https://search.example.test/private/');
  expect(value.SEARXNG_API_KEY).toBe('search-secret');
  expect(value).not.toHaveProperty('SEARXNG_SECRET');
});
```

- [ ] **Step 2: Run environment tests and observe failure**

Run: `npx vitest run agent/src/config/env.test.ts`

Expected: FAIL because `SEARXNG_BASE_URL` and `SEARXNG_API_KEY` are absent.

- [ ] **Step 3: Add the two environment fields**

Extend `envSchema` in `agent/src/config/env.ts`:

```ts
SEARXNG_BASE_URL: optionalUrl.default(''),
SEARXNG_API_KEY: z.string().default(''),
```

- [ ] **Step 4: Add failing URL/configuration tests**

Create `agent/src/mastra/searxng/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  parseSearxngConfiguration,
  searxngEndpoint,
} from './config.js';

describe('SearXNG configuration', () => {
  it('treats an empty endpoint as unconfigured', () => {
    expect(parseSearxngConfiguration({ baseUrl: '', apiKey: '' })).toBeUndefined();
  });

  it('preserves a deployment path and constructs fixed endpoints', () => {
    const config = parseSearxngConfiguration({
      baseUrl: 'https://search.example.test/private',
      apiKey: 'token',
    })!;
    expect(searxngEndpoint(config, 'config').href)
      .toBe('https://search.example.test/private/config');
    expect(searxngEndpoint(config, 'search').href)
      .toBe('https://search.example.test/private/search');
    expect(config.apiKey).toBe('token');
  });

  it.each([
    'ftp://search.example.test',
    'https://user:pass@search.example.test',
    'https://search.example.test?q=secret',
    'https://search.example.test/#fragment',
  ])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => parseSearxngConfiguration({ baseUrl, apiKey: '' }))
      .toThrow('SearXNG search configuration is invalid.');
  });

  it('rejects bearer values containing line breaks without echoing the value', () => {
    const secret = 'private\r\nInjected: yes';
    expect(() => parseSearxngConfiguration({
      baseUrl: 'https://search.example.test',
      apiKey: secret,
    })).toThrow('SearXNG search configuration is invalid.');
    try {
      parseSearxngConfiguration({ baseUrl: 'https://search.example.test', apiKey: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 5: Run configuration tests and observe failure**

Run: `npx vitest run agent/src/mastra/searxng/config.test.ts`

Expected: FAIL because `./config.js` does not exist.

- [ ] **Step 6: Implement strict server configuration**

Create `agent/src/mastra/searxng/config.ts`:

```ts
export interface SearxngConfigurationInput {
  baseUrl: string;
  apiKey: string;
}

export interface SearxngConfiguration {
  baseUrl: URL;
  apiKey?: string;
}

const INVALID_CONFIGURATION = 'SearXNG search configuration is invalid.';

export function parseSearxngConfiguration(
  input: SearxngConfigurationInput,
): SearxngConfiguration | undefined {
  if (!input.baseUrl.trim()) return undefined;
  try {
    const baseUrl = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol)
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
      || /[\r\n]/.test(input.apiKey)) {
      throw new Error(INVALID_CONFIGURATION);
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    return { baseUrl, ...(input.apiKey ? { apiKey: input.apiKey } : {}) };
  } catch {
    throw new Error(INVALID_CONFIGURATION);
  }
}

export function searxngEndpoint(
  config: SearxngConfiguration,
  path: 'config' | 'search',
): URL {
  return new URL(path, config.baseUrl);
}
```

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run agent/src/config/env.test.ts agent/src/mastra/searxng/config.test.ts`

Expected: 2 files PASS.

- [ ] **Step 8: Commit configuration boundary**

```bash
git add agent/src/config/env.ts agent/src/config/env.test.ts agent/src/mastra/searxng/config.ts agent/src/mastra/searxng/config.test.ts
git commit -m "feat(agent): validate SearXNG configuration"
```

---

### Task 2: Bounded SearXNG HTTP Client

**Files:**
- Create: `agent/src/mastra/searxng/client.ts`
- Create: `agent/src/mastra/searxng/client.test.ts`

**Interfaces:**
- Consumes: `SearxngConfiguration` and `searxngEndpoint()` from Task 1.
- Produces: `SearxngSearchInput`, `SearxngSearchOutput`, `SearxngSearchClient`, and `createSearxngSearchClient(options)`.
- `SearxngSearchClient.search(input, signal?)` is the only tool-facing operation.

- [ ] **Step 1: Define transport fixtures and failing request tests**

Create `agent/src/mastra/searxng/client.test.ts` with a response helper and these first cases:

```ts
import { describe, expect, it, vi } from 'vitest';

import { parseSearxngConfiguration } from './config.js';
import { createSearxngSearchClient } from './client.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json' }, ...init },
);

const config = parseSearxngConfiguration({
  baseUrl: 'https://search.example.test/private/',
  apiKey: 'private-token',
})!;

describe('SearXNG search client', () => {
  it('posts only fixed search form fields with server-owned authentication', async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createSearxngSearchClient({ config, fetch });

    await client.search({
      query: 'competitor research',
      maxResults: 10,
      page: 2,
      safeSearch: 1,
      timeRange: 'month',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://search.example.test/private/search');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer private-token',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    expect(String(init.body)).toBe(
      'q=competitor+research&format=json&pageno=2&time_range=month&safesearch=1',
    );
  });

  it('fails closed when no endpoint is configured', async () => {
    const client = createSearxngSearchClient({ config: undefined, fetch: vi.fn() });
    await expect(client.search({ query: 'x', maxResults: 10, page: 1 }))
      .rejects.toThrow('SearXNG search is not configured.');
  });
});
```

- [ ] **Step 2: Run the client tests and observe missing-module failure**

Run: `npx vitest run agent/src/mastra/searxng/client.test.ts`

Expected: FAIL because `./client.js` does not exist.

- [ ] **Step 3: Add public types, limits, and fixed request transport**

Create `agent/src/mastra/searxng/client.ts` with these exact public interfaces and constants:

```ts
import type { SearxngConfiguration } from './config.js';
import { searxngEndpoint } from './config.js';

export interface SearxngSearchInput {
  query: string;
  maxResults: number;
  page: number;
  language?: string;
  categories?: string[];
  engines?: string[];
  safeSearch?: 0 | 1 | 2;
  timeRange?: 'day' | 'month' | 'year';
}

export interface SearxngSearchResult {
  url: string;
  title: string;
  snippet: string;
  engines: string[];
  category?: string;
  score?: number;
  publishedAt?: string;
}

export interface SearxngSearchOutput {
  query: string;
  page: number;
  results: SearxngSearchResult[];
  answers: string[];
  corrections: string[];
  suggestions: string[];
  truncated: boolean;
}

export interface SearxngSearchClient {
  search(input: SearxngSearchInput, signal?: AbortSignal): Promise<SearxngSearchOutput>;
}

export interface SearxngSearchClientOptions {
  config: SearxngConfiguration | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 131_072;
const CAPABILITY_CACHE_MS = 5 * 60 * 1000;
```

Implement `createSearxngSearchClient()` so it builds `URLSearchParams` in stable
order (`q`, `format`, `pageno`, `language`, `categories`, `engines`,
`time_range`, `safesearch`), uses `redirect: 'error'`, adds only approved
headers, and combines the caller signal with a 12-second timeout signal.

- [ ] **Step 4: Run request tests and observe pass**

Run: `npx vitest run agent/src/mastra/searxng/client.test.ts`

Expected: first request/configuration cases PASS; subsequent cases are not added yet.

- [ ] **Step 5: Add failing capability-validation tests**

Append tests covering one `/config` fetch, five-minute cache reuse, and rejection
before `/search`:

```ts
it('validates and caches optional targeting from fixed config', async () => {
  let now = 1_000;
  const fetch = vi.fn(async (url: URL | RequestInfo) => String(url).endsWith('/config')
    ? jsonResponse({
        categories: ['general', 'news'],
        locales: { en: 'English' },
        engines: [
          { name: 'brave', enabled: true, languages: ['en'] },
          { name: 'disabled', enabled: false, languages: ['en'] },
        ],
      })
    : jsonResponse({ results: [] }));
  const client = createSearxngSearchClient({ config, fetch, now: () => now });
  const input = {
    query: 'x', maxResults: 10, page: 1,
    language: 'en', categories: ['general'], engines: ['brave'],
  };

  await client.search(input);
  now += 299_999;
  await client.search(input);

  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/config'))).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/search'))).toHaveLength(2);
});

it.each([
  [{ language: 'xx' }, 'language'],
  [{ categories: ['unknown'] }, 'categories'],
  [{ engines: ['disabled'] }, 'engines'],
])('rejects unsupported targeting %j before search', async (targeting) => {
  const fetch = vi.fn(async () => jsonResponse({
    categories: ['general'],
    locales: { en: 'English' },
    engines: [{ name: 'brave', enabled: true, languages: ['en'] }],
  }));
  const client = createSearxngSearchClient({ config, fetch });
  await expect(client.search({
    query: 'x', maxResults: 10, page: 1, ...targeting,
  })).rejects.toThrow('Search targeting is not supported by the configured SearXNG instance.');
  expect(fetch).toHaveBeenCalledOnce();
});
```

- [ ] **Step 6: Implement sanitized capability caching**

Inside `createSearxngSearchClient()`, keep a closure cache with this shape:

```ts
interface Capabilities {
  categories: Set<string>;
  engines: Set<string>;
  languages: Set<string>;
}

let cachedCapabilities:
  | { value: Capabilities; expiresAt: number }
  | undefined;
```

Normalize only top-level category strings, enabled engine names, engine language
strings, locale keys, `all`, and `auto`. Do not cache rejected HTTP, MIME, size,
JSON, or schema responses. Validate every requested optional value before the
search request.

- [ ] **Step 7: Add failing transport-error and secrecy tests**

Add table-driven cases for timeout, redirect/fetch failure, `403`, non-JSON MIME,
oversized streamed body, and malformed JSON. For each case, include private
endpoint/token/body strings and assert none appear in `String(error)`:

```ts
it.each([
  [new Response('forbidden-private-body', { status: 403 }),
    'The configured SearXNG instance does not provide JSON search.'],
  [new Response('<html>private</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }), 'The configured SearXNG instance does not provide JSON search.'],
  [new Response('{bad', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }), 'SearXNG returned an invalid response.'],
])('maps unsafe upstream response to fixed error', async (response, message) => {
  const fetch = vi.fn(async () => response);
  const client = createSearxngSearchClient({ config, fetch });
  const error = await client.search({ query: 'x', maxResults: 10, page: 1 })
    .then(() => undefined, (reason: unknown) => reason);
  expect(String(error)).toContain(message);
  expect(String(error)).not.toMatch(/private-token|search\.example|private-body|<html>/);
});
```

Build the oversized response with a `ReadableStream` that emits chunks totaling
`2 * 1024 * 1024 + 1`; expect `SearXNG returned too much data.` Build the timeout
fetch mock so it rejects when `init.signal` aborts; expect
`SearXNG search timed out. Try again.`

- [ ] **Step 8: Implement bounded body reading and fixed error mapping**

Implement one `readBoundedJson(response)` helper that reads `response.body` with
a reader, counts bytes before concatenation, cancels on overflow, checks JSON
MIME, and parses only after the full bounded body arrives. Map:

```ts
const ERRORS = {
  unavailable: 'SearXNG search is unavailable. Try again later.',
  timeout: 'SearXNG search timed out. Try again.',
  format: 'The configured SearXNG instance does not provide JSON search.',
  tooLarge: 'SearXNG returned too much data.',
  invalid: 'SearXNG returned an invalid response.',
  targeting: 'Search targeting is not supported by the configured SearXNG instance.',
} as const;
```

Never append caught messages or response values. Distinguish timeout by the
client-owned timeout signal, while preserving caller cancellation as a fixed
unavailable/cancelled failure without leaking the abort reason.

- [ ] **Step 9: Add failing normalization and 128 KiB output tests**

Add tests proving:

```ts
expect(output.results[0]).toEqual({
  url: 'https://product.example/',
  title: 'Product',
  snippet: 'Useful summary',
  engines: ['brave'],
  category: 'general',
  score: 3.5,
  publishedAt: '2026-07-19T00:00:00.000Z',
});
expect(output.results.some((item) => item.url.startsWith('file:'))).toBe(false);
expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(131_072);
expect(output.truncated).toBe(true);
```

Fixture must include 21 results, one `file:` URL, overlong title/snippet/engine,
invalid date/score, 6 answers, 11 corrections, and 11 suggestions. Also test a
small clean response returns `truncated: false`.

- [ ] **Step 10: Implement deterministic normalization**

Use byte-aware truncation that never splits a UTF-8 code point. Apply exact
limits from Global Constraints and the spec. Normalize results in upstream order,
slice to `maxResults`, then normalize auxiliary arrays. If serialized output is
still too large, remove trailing suggestions, corrections, answers, then results
until it fits. Set `truncated` whenever an item/field is omitted or shortened.

- [ ] **Step 11: Run client and type tests**

Run:

```bash
npx vitest run agent/src/mastra/searxng/config.test.ts agent/src/mastra/searxng/client.test.ts
npm run typecheck --workspace agent
```

Expected: tests PASS; TypeScript exits 0.

- [ ] **Step 12: Commit bounded client**

```bash
git add agent/src/mastra/searxng/client.ts agent/src/mastra/searxng/client.test.ts
git commit -m "feat(agent): add bounded SearXNG client"
```

---

### Task 3: `search_web` Tool And Fixed MCP Server

**Files:**
- Create: `agent/src/mastra/tools/searxng-search.ts`
- Create: `agent/src/mastra/tools/searxng-search.test.ts`
- Create: `agent/src/mastra/mcp/searxng-mcp-server.ts`
- Create: `agent/src/mastra/mcp/searxng-mcp-server.test.ts`

**Interfaces:**
- Consumes: `createSearxngSearchClient()`, `SearxngSearchClient`, and search types.
- Produces: `createSearchWebTool(client?)`, `searchWebTool`,
  `createSearxngMcpServer(tool?)`, and `searxngMcpServer`.

- [ ] **Step 1: Add failing tool schema and behavior tests**

Create `agent/src/mastra/tools/searxng-search.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createSearchWebTool } from './searxng-search.js';

describe('search_web tool', () => {
  it('exposes exact read-only open-world behavior without approval', () => {
    const tool = createSearchWebTool({ search: vi.fn() });
    expect(tool.id).toBe('search_web');
    expect(tool.requireApproval).toBeUndefined();
    expect(tool.mcp?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('applies defaults and forwards the caller abort signal', async () => {
    const search = vi.fn(async (input) => ({
      query: input.query, page: input.page, results: [], answers: [],
      corrections: [], suggestions: [], truncated: false,
    }));
    const tool = createSearchWebTool({ search });
    const abortSignal = new AbortController().signal;
    await tool.execute?.({ query: ' products ' }, { abortSignal } as never);
    expect(search).toHaveBeenCalledWith({
      query: 'products', maxResults: 10, page: 1,
    }, abortSignal);
  });

  it.each([
    { query: '' },
    { query: 'x'.repeat(1025) },
    { query: '雪'.repeat(342) },
    { query: 'x', maxResults: 21 },
    { query: 'x', page: 6 },
    { query: 'x', categories: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { query: 'x', categories: ['general', 'general'] },
    { query: 'x', engines: Array.from({ length: 11 }, (_, index) => `e${index}`) },
    { query: 'x', endpoint: 'https://evil.test' },
    { query: 'x', timeRange: 'week' },
  ])('rejects invalid strict input %#', (input) => {
    const tool = createSearchWebTool({ search: vi.fn() });
    expect(tool.inputSchema.safeParse(input).success).toBe(false);
  });
});
```

The multibyte query case proves the 1,024-byte rule is byte-based, not
character-based. Direct `tool.execute` remains reserved for already-validated
inputs because Mastra owns schema parsing at the external invocation boundary.

- [ ] **Step 2: Run tool tests and observe failure**

Run: `npx vitest run agent/src/mastra/tools/searxng-search.test.ts`

Expected: FAIL because tool module does not exist.

- [ ] **Step 3: Implement strict schemas and reusable tool**

Create `agent/src/mastra/tools/searxng-search.ts`. Use `z.object(...).strict()`,
unique-list refinements, enum schemas, and this factory shape:

```ts
export function createSearchWebTool(
  client: SearxngSearchClient = createSearxngSearchClient({
    config: parseSearxngConfiguration({
      baseUrl: env.SEARXNG_BASE_URL,
      apiKey: env.SEARXNG_API_KEY,
    }),
  }),
) {
  return createTool({
    id: 'search_web',
    description: 'Search the web through the server-owned SearXNG instance and return bounded result metadata and snippets.',
    inputSchema,
    outputSchema,
    mcp: { annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    } },
    execute: async (input, context) => client.search({
      ...input,
      query: input.query.trim(),
      maxResults: input.maxResults ?? 10,
      page: input.page ?? 1,
    }, context.abortSignal),
  });
}

export const searchWebTool = createSearchWebTool();
```

Output schema must exactly match Task 2's public normalized output and contain
no passthrough keys.

- [ ] **Step 4: Add failing immutable-MCP tests**

Create `agent/src/mastra/mcp/searxng-mcp-server.test.ts`:

```ts
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createSearxngMcpServer,
  searxngMcpServer,
} from './searxng-mcp-server.js';

describe('SearXNG MCP server', () => {
  it('registers exactly search_web', () => {
    expect(searxngMcpServer.id).toBe('searxng');
    expect(Object.keys(searxngMcpServer.tools())).toEqual(['search_web']);
  });

  it('rejects dynamic registry mutation', async () => {
    const server = createSearxngMcpServer();
    const extra = createTool({
      id: 'extra', description: 'not allowed', inputSchema: z.object({}),
      execute: async () => ({}),
    });
    await expect(server.toolActions.add({ extra }))
      .rejects.toThrow('SearXNG MCP tool registry is fixed.');
    await expect(server.toolActions.remove(['search_web']))
      .rejects.toThrow('SearXNG MCP tool registry is fixed.');
    expect(Object.keys(server.tools())).toEqual(['search_web']);
  });
});
```

- [ ] **Step 5: Implement fixed MCP server**

Create `agent/src/mastra/mcp/searxng-mcp-server.ts` following Garage's immutable
registry pattern, without Garage's agent-context conversion override:

```ts
class SearxngMcpServer extends MCPServer {
  constructor(tools: ToolsInput) {
    super({ id: 'searxng', name: 'SearXNG MCP', version: '0.1.0', tools });
    const rejectMutation = async (): Promise<void> => {
      throw new Error('SearXNG MCP tool registry is fixed.');
    };
    this.toolActions.add = rejectMutation;
    this.toolActions.remove = rejectMutation;
  }
}

export function createSearxngMcpServer(tool = searchWebTool): MCPServer {
  return new SearxngMcpServer({ search_web: tool });
}

export const searxngMcpServer = createSearxngMcpServer();
```

- [ ] **Step 6: Run tool/MCP tests and agent typecheck**

Run:

```bash
npx vitest run agent/src/mastra/tools/searxng-search.test.ts agent/src/mastra/mcp/searxng-mcp-server.test.ts
npm run typecheck --workspace agent
```

Expected: both test files PASS; typecheck exits 0.

- [ ] **Step 7: Commit tool and MCP server**

```bash
git add agent/src/mastra/tools/searxng-search.ts agent/src/mastra/tools/searxng-search.test.ts agent/src/mastra/mcp/searxng-mcp-server.ts agent/src/mastra/mcp/searxng-mcp-server.test.ts
git commit -m "feat(agent): add fixed SearXNG MCP"
```

---

### Task 4: Runtime, PM Agent, And Stored-Agent Hydration

**Files:**
- Modify: `agent/src/mastra/index.ts:15-33`
- Modify: `agent/src/__tests__/agent-routes.test.ts:1-35`
- Modify: `agent/src/agents/pm-agent.ts:4-75`
- Modify: `agent/src/agents/__tests__/both-agents.test.ts:38-51`
- Modify: `agent/src/mastra/mcp/searxng-mcp-server.test.ts`

**Interfaces:**
- Consumes: `searchWebTool` and `searxngMcpServer` from Task 3.
- Produces: runtime registry key `searxng`; PM tool key `search_web`.

- [ ] **Step 1: Add failing runtime and PM registry assertions**

Update `agent/src/__tests__/agent-routes.test.ts` to import
`searxngMcpServer` and expect:

```ts
expect(mastra.listMCPServers()).toEqual({
  garage: garageMcpServer,
  searxng: searxngMcpServer,
});
```

Update PM tool expectation in `both-agents.test.ts`:

```ts
expect(Object.keys(tools).sort()).toEqual([
  'list_pm_reports_from_garage',
  'save_pm_report_to_garage',
  'search_web',
  'view_pm_report_from_garage',
]);
```

Keep the complete PM instruction string assertion byte-for-byte unchanged.

- [ ] **Step 2: Run tests and observe registry failures**

Run:

```bash
npx vitest run agent/src/__tests__/agent-routes.test.ts agent/src/agents/__tests__/both-agents.test.ts
```

Expected: FAIL because runtime and PM Agent do not register SearXNG.

- [ ] **Step 3: Register SearXNG in runtime and PM Agent**

In `agent/src/mastra/index.ts`, import the singleton and change only:

```ts
mcpServers: {
  garage: garageMcpServer,
  searxng: searxngMcpServer,
},
```

In `pm-agent.ts`, import `searchWebTool` and add:

```ts
  save_pm_report_to_garage: savePmReportToGarageTool,
  list_pm_reports_from_garage: listPmReportsFromGarageTool,
  view_pm_report_from_garage: viewPmReportFromGarageTool,
  search_web: searchWebTool,
},
```

Do not modify PM instructions, description, Memory, or `maxSteps`.

- [ ] **Step 4: Add failing stored-agent hydration test**

Extend `searxng-mcp-server.test.ts` with an in-memory `MastraEditor` runtime that
registers both MCP servers and creates:

```ts
mcpClients: {
  garage: { tools: {} },
  searxng: { tools: {} },
}
```

Inject a fake SearXNG tool/client so execution performs no network request. Assert
hydrated tools equal the five Garage IDs plus `search_web`, then execute
`search_web` and assert the fake normalized result.

- [ ] **Step 5: Run runtime, hydration, and Garage regression tests**

Run:

```bash
npx vitest run agent/src/__tests__/agent-routes.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/mcp/searxng-mcp-server.test.ts agent/src/mastra/mcp/garage-mcp-server.test.ts agent/src/mastra/tools/pm-report-tools.test.ts
```

Expected: all files PASS; Garage test still reports exactly five tools.

- [ ] **Step 6: Commit runtime integration**

```bash
git add agent/src/mastra/index.ts agent/src/__tests__/agent-routes.test.ts agent/src/agents/pm-agent.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/mastra/mcp/searxng-mcp-server.test.ts
git commit -m "feat(agent): expose SearXNG search"
```

---

### Task 5: Fixed Stored-Agent Payload And Proxy Validation

**Files:**
- Modify: `client/src/server/agent-payload.ts:1-121`
- Modify: `client/src/server/agent-payload.test.ts:17-61`
- Modify: `client/src/app/api/agent/[...path]/route.ts:13-34`
- Modify: `client/src/app/api/agent/[...path]/route.test.ts:30-108`

**Interfaces:**
- Produces: `STUDIO_MCP_CLIENT_IDS = ['garage', 'searxng']`.
- Proxy accepts a non-empty subset where every value is exactly `{ tools: {} }`.

- [ ] **Step 1: Add failing payload tests for SearXNG and both IDs**

Change the MCP constant expectation and add:

```ts
it.each([
  [['garage'], { garage: { tools: {} } }],
  [['searxng'], { searxng: { tools: {} } }],
  [['garage', 'searxng'], {
    garage: { tools: {} },
    searxng: { tools: {} },
  }],
])('serializes fixed MCP selection %j', (mcpClients, expected) => {
  const payload = toStoredAgentPayload({
    id: 'demo', name: 'Demo', description: '', instructions: 'Help',
    model: 'model-a', tools: [], agents: [], mcpClients,
    memoryEnabled: true,
  });
  expect(payload.mcpClients).toEqual(expected);
  expect(readMcpClientIds(payload.mcpClients)).toEqual(mcpClients);
});
```

Retain unknown URL/package/credential filtering tests and include `searxng` in
the expected valid output.

- [ ] **Step 2: Run payload tests and observe failure**

Run: `npx vitest run client/src/server/agent-payload.test.ts`

Expected: SearXNG cases FAIL because only Garage is whitelisted.

- [ ] **Step 3: Extend the fixed client ID tuple**

Change only:

```ts
export const STUDIO_MCP_CLIENT_IDS = ['garage', 'searxng'] as const;
```

Existing filtering and `optionRecord` logic should handle both without a second
serialization path.

- [ ] **Step 4: Add failing proxy subset and attack tests**

Update route tests so accepted payloads include Garage only, SearXNG only, and
both. Add rejected cases for:

```ts
{ mcpClients: {} }
{ mcpClients: { unknown: { tools: {} } } }
{ mcpClients: { searxng: { url: 'https://evil.test' } } }
{ mcpClients: { searxng: { command: 'npx', args: ['evil'] } } }
{ mcpClients: { searxng: { tools: {}, env: { TOKEN: 'secret' } } } }
{ mcpClients: { searxng: { tools: { search_web: {} } } } }
{ mcpClients: { garage: { tools: {} }, searxng: { tools: {} }, extra: {} } }
```

Run each relevant payload through POST, PATCH, and PUT alias forms; assert status
400, fixed response text, and no upstream fetch.

- [ ] **Step 5: Run proxy tests and observe multi-ID failure**

Run: `npx vitest run client/src/app/api/agent/[...path]/route.test.ts`

Expected: SearXNG-only and both-ID valid cases FAIL.

- [ ] **Step 6: Generalize proxy validation to fixed subsets**

Replace Garage-specific logic with:

```ts
const allowedMcpClientIds = new Set<string>(STUDIO_MCP_CLIENT_IDS);

function isEmptyToolsSelection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'tools') return false;
  const tools = (value as Record<string, unknown>).tools;
  return Boolean(tools)
    && typeof tools === 'object'
    && !Array.isArray(tools)
    && Object.keys(tools as Record<string, unknown>).length === 0;
}
```

`hasAllowedMcpConfig()` must return true when `mcpClients` is absent. When
present, require 1-2 keys, require every key in `allowedMcpClientIds`, and require
every value to pass `isEmptyToolsSelection()`.

- [ ] **Step 7: Run client security tests and typecheck**

Run:

```bash
npx vitest run client/src/server/agent-payload.test.ts client/src/app/api/agent/[...path]/route.test.ts
npm run typecheck --workspace client
```

Expected: tests PASS; typecheck exits 0.

- [ ] **Step 8: Commit payload/proxy security change**

```bash
git add client/src/server/agent-payload.ts client/src/server/agent-payload.test.ts client/src/app/api/agent/[...path]/route.ts client/src/app/api/agent/[...path]/route.test.ts
git commit -m "feat(client): whitelist SearXNG MCP"
```

---

### Task 6: Agent Builder Capability Cards

**Files:**
- Modify: `client/src/components/agents/agent-builder-page.tsx:56-84,403-432`
- Modify: `client/src/lib/ui-structure.test.ts:68-82`

**Interfaces:**
- Consumes: `STUDIO_MCP_CLIENT_IDS` from Task 5.
- Produces: separate fixed Garage and SearXNG cards; no configuration controls.

- [ ] **Step 1: Add failing UI structure assertions**

Replace Garage-only assertions with checks for both descriptions:

```ts
expect(agentBuilder).toContain('STUDIO_MCP_CLIENT_IDS.map');
expect(agentBuilder).toContain('Create, read, list, replace, and delete agent-isolated text objects in Garage.');
expect(agentBuilder).toContain('Search the web through the server-owned SearXNG instance and return result snippets.');
expect(agentBuilder).toContain("set('mcpClients', toggle(values.mcpClients, mcpClientId))");
expect(agentBuilder).not.toMatch(
  /mcpUrl|mcpCommand|mcpPackage|mcpCredentials|SEARXNG_BASE_URL|SEARXNG_API_KEY/,
);
```

Rename the hydration test to preserve Garage, SearXNG, or both selections.

- [ ] **Step 2: Run UI structure test and observe failure**

Run: `npx vitest run client/src/lib/ui-structure.test.ts`

Expected: FAIL because SearXNG metadata is absent.

- [ ] **Step 3: Add fixed MCP display metadata**

Add:

```ts
const MCP_META: Record<string, { title: string; description: string; icon: string }> = {
  garage: {
    title: 'Garage',
    description: 'Create, read, list, replace, and delete agent-isolated text objects in Garage.',
    icon: 'G',
  },
  searxng: {
    title: 'SearXNG Search',
    description: 'Search the web through the server-owned SearXNG instance and return result snippets.',
    icon: 'S',
  },
};
```

Render icon/title/description from `MCP_META[mcpClientId]` in the existing fixed
map. Do not add text fields, advanced forms, endpoint status requests, or browser
environment reads.

- [ ] **Step 4: Run UI, payload, and lint checks**

Run:

```bash
npx vitest run client/src/lib/ui-structure.test.ts client/src/server/agent-payload.test.ts
npm run lint --workspace client
```

Expected: tests PASS; lint exits 0.

- [ ] **Step 5: Commit builder support**

```bash
git add client/src/components/agents/agent-builder-page.tsx client/src/lib/ui-structure.test.ts
git commit -m "feat(client): add SearXNG capability card"
```

---

### Task 7: Pinned Local SearXNG Service And Environment Helper

**Files:**
- Create: `searxng/settings.yml`
- Create: `scripts/searxng-env.sh`
- Modify: `compose.yaml`
- Modify: `.gitignore:4-13`
- Modify: `scripts/dev.test.ts:56-75,195-285,525-555`

**Interfaces:**
- Produces local `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`,
  `SEARXNG_BASE_URL=http://127.0.0.1:8888`, and empty `SEARXNG_API_KEY` in the
  launcher shell.
- Persists only ignored `searxng/.env.local`; tracked settings contain no secret.

- [ ] **Step 1: Extend launcher fixtures and add failing environment tests**

In `scripts/dev.test.ts`, create fixture directory `searxng`, copy
`scripts/searxng-env.sh` and `searxng/settings.yml`, and add tests that:

```ts
expect(parse(firstContent).SEARXNG_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(parse(firstContent).SEARXNG_CONFIG_HASH).toMatch(/^[a-f0-9]{64}$/);
expect(parse(firstContent).SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
expect(parse(firstContent).SEARXNG_API_KEY).toBe('');
expect(readFileSync(envPath, 'utf8')).toBe(firstContent);
expect(result.stdout + result.stderr).not.toContain(parse(firstContent).SEARXNG_SECRET!);
```

Modify tracked settings in the fixture, rerun helper, and assert the secret stays
stable while `SEARXNG_CONFIG_HASH` changes. Assert generated
`agent/.env.development` contains one base URL and one empty API key, but no
secret/hash.

- [ ] **Step 2: Run focused helper tests and observe missing-file failure**

Run: `npx vitest run scripts/dev.test.ts -t "SearXNG environment"`

Expected: FAIL because helper/settings do not exist.

- [ ] **Step 3: Add tracked settings and focused helper**

Create `searxng/settings.yml` with the exact approved YAML from the spec.

Create `scripts/searxng-env.sh` using `set -euo pipefail`, `umask 077`, atomic
temporary files, Node `crypto.randomBytes(32).toString('base64url')`, and
`createHash('sha256').update(settings).digest('hex')`. Generated file contains:

```text
SEARXNG_SECRET=<stable random value>
SEARXNG_CONFIG_HASH=<current settings hash>
SEARXNG_BASE_URL=http://127.0.0.1:8888
SEARXNG_API_KEY=
```

After sourcing, rewrite `agent/.env.development` produced by `storage-env.sh`:
remove every existing `SEARXNG_BASE_URL`/`SEARXNG_API_KEY` assignment and append
the two local application values with the same dotenv-safe serializer strategy
used by `storage-env.sh`. If `agent/.env` is absent, do not create
`agent/.env.development`.

- [ ] **Step 4: Add failing committed-runtime assertions**

Extend `scripts/dev.test.ts` to assert:

```ts
expect(compose).toContain('docker.io/searxng/searxng:2026.7.18-277d8469c');
expect(compose).toContain('"127.0.0.1:8888:8080"');
expect(compose).toMatch(/\.\/searxng\/settings\.yml:\/etc\/searxng\/settings\.yml:ro/);
expect(compose).toMatch(/searxng-cache:\/var\/cache\/searxng/);
expect(settings).toMatch(/formats:\s*\r?\n\s*- html\s*\r?\n\s*- json/);
expect(settings).toMatch(/limiter:\s*false/);
expect(settings).toMatch(/public_instance:\s*false/);
expect(settings).toMatch(/image_proxy:\s*false/);
```

Read `settings` from `searxng/settings.yml` as text; do not add a YAML parser.

- [ ] **Step 5: Add pinned Compose service**

Extend `compose.yaml`:

```yaml
  searxng:
    image: docker.io/searxng/searxng:2026.7.18-277d8469c
    restart: unless-stopped
    environment:
      SEARXNG_SECRET: ${SEARXNG_SECRET:?Set SEARXNG_SECRET}
    labels:
      chekku.searxng-config-hash: ${SEARXNG_CONFIG_HASH:?Set SEARXNG_CONFIG_HASH}
    ports:
      - "127.0.0.1:8888:8080"
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
      - searxng-cache:/var/cache/searxng
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 5s
```

Add `searxng-cache:` under top-level volumes. Add explicit
`searxng/.env.local` ignore even though global `.env.*` already matches, so
repository policy remains visible.

- [ ] **Step 6: Run helper/runtime tests and Compose validation**

Run:

```bash
npx vitest run scripts/dev.test.ts -t "SearXNG environment|committed Garage runtime"
bash -lc 'source scripts/storage-env.sh; source scripts/searxng-env.sh; docker compose --env-file storage/.env.local config --quiet'
git status --short
```

Expected: focused tests PASS; Compose exits 0; generated SearXNG files remain
ignored; no secret appears in command output or Git status.

- [ ] **Step 7: Commit local service definition**

```bash
git add searxng/settings.yml scripts/searxng-env.sh compose.yaml .gitignore scripts/dev.test.ts
git commit -m "feat(dev): add local SearXNG service"
```

---

### Task 8: Dual-Service Launcher Lifecycle

**Files:**
- Modify: `scripts/dev.sh:26-299`
- Modify: `scripts/dev.test.ts:77-165,287-523`

**Interfaces:**
- Consumes: environment exports from Garage and SearXNG helpers.
- Produces: bounded startup for `garage` and `searxng`; Mastra-only SearXNG app values; no Next.js `SEARXNG_*` values.

- [ ] **Step 1: Generalize Docker mock and add failing dual-service tests**

Update fixture Docker mock so `ps -q garage` and `ps -q searxng` return distinct
IDs, and `inspect` can return service-specific health. Add tests asserting:

```ts
expect(calls).toContain('compose --env-file storage/.env.local ps -q garage');
expect(calls).toContain('compose --env-file storage/.env.local ps -q searxng');
expect(calls).toMatch(/compose .* up -d .*garage/);
expect(calls).toMatch(/compose .* up -d .*searxng/);
expect(result.stdout).toContain('Garage ready');
expect(result.stdout).toContain('SearXNG ready');
```

Add separate tests for occupied SearXNG port, SearXNG health timeout, hanging
SearXNG `ps`/`inspect` process cleanup, and no application launch until both are
healthy.

Update the environment-capture npm mock from Garage-only `grep` to:

```bash
env | grep -E '^(GARAGE|SEARXNG)_' | sort > "$MOCK_LOG/env-$role"
```

- [ ] **Step 2: Add failing environment-isolation test**

Extend the mock npm capture test. Expected names:

```ts
expect(agentNames).toEqual([
  'GARAGE_ACCESS_KEY_ID',
  'GARAGE_BUCKET',
  'GARAGE_ENDPOINT',
  'GARAGE_REGION',
  'GARAGE_SECRET_ACCESS_KEY',
  'SEARXNG_API_KEY',
  'SEARXNG_BASE_URL',
]);
expect(clientNames).toEqual([
  'GARAGE_ACCESS_KEY_ID',
  'GARAGE_BUCKET',
  'GARAGE_ENDPOINT',
  'GARAGE_REGION',
  'GARAGE_SECRET_ACCESS_KEY',
]);
```

Seed unrelated `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`, and
`SEARXNG_UNRELATED`; prove none reaches either app.

- [ ] **Step 3: Run launcher tests and observe failures**

Run: `npx vitest run scripts/dev.test.ts -t "development launcher"`

Expected: new SearXNG lifecycle and isolation cases FAIL.

- [ ] **Step 4: Source SearXNG helper and parameterize service checks**

After `storage-env.sh`, source `searxng-env.sh`. Replace Garage-only status,
health, timeout, and port helpers with service-parameterized functions accepting:

```text
service name
display name
test port (3900 or 8888)
```

Retain `run_with_timeout()` and process-group termination semantics. Query each
service ID before port checks. Start Garage with existing force-recreate behavior;
start SearXNG through normal Compose reconciliation so image/label changes cause
recreation. Poll each container health under one bounded deadline and emit fixed
service-specific errors.

- [ ] **Step 5: Isolate app process environments**

Define cleanup snippets with exact allowlists:

```bash
garage_app_cleanup='for garage_name in ${!GARAGE_@}; do case "$garage_name" in GARAGE_ENDPOINT|GARAGE_REGION|GARAGE_BUCKET|GARAGE_ACCESS_KEY_ID|GARAGE_SECRET_ACCESS_KEY) ;; *) unset "$garage_name" ;; esac; done'
searxng_agent_cleanup='for searxng_name in ${!SEARXNG_@}; do case "$searxng_name" in SEARXNG_BASE_URL|SEARXNG_API_KEY) ;; *) unset "$searxng_name" ;; esac; done'
searxng_client_cleanup='for searxng_name in ${!SEARXNG_@}; do unset "$searxng_name"; done'
```

Apply Garage plus agent cleanup in Mastra tmux/fallback command. Apply Garage
plus client cleanup in Next.js tmux/fallback command. Preserve fallback process
group IDs and bounded TERM/KILL cleanup by launching each role in its own
background subshell with `exec`.

- [ ] **Step 6: Run complete launcher suite**

Run: `npx vitest run scripts/dev.test.ts`

Expected: every launcher/environment/runtime test PASS on Windows Git Bash or
Linux; no orphan-process test regresses.

- [ ] **Step 7: Commit launcher integration**

```bash
git add scripts/dev.sh scripts/dev.test.ts
git commit -m "feat(dev): launch Garage and SearXNG"
```

---

### Task 9: Public Documentation And Repository Invariants

**Files:**
- Modify: `.env.example`
- Modify: `agent/.env.example`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Documents only the implemented search foundation; Web Reader and competitive analysis remain future branches.

- [ ] **Step 1: Add environment examples**

Add to both tracked agent environment references:

```dotenv
# Server-owned SearXNG search endpoint. Local scripts/dev.sh supplies this.
SEARXNG_BASE_URL=
# Optional bearer token for an authenticated external SearXNG reverse proxy.
SEARXNG_API_KEY=
```

Do not document or add `SEARXNG_SECRET` as application configuration.

- [ ] **Step 2: Update README public contract**

Document:

```text
- SearXNG is a fixed read-only MCP capability available to PM Agent and selectable stored agents.
- Local `npm run dev:sh` starts Garage, SearXNG on http://127.0.0.1:8888, Mastra, and Next.js.
- `search_web` returns bounded titles, URLs, snippets, answers, corrections, and suggestions; it does not download page content.
- Stored records contain only `mcpClients: { searxng: { tools: {} } }`; endpoint and optional bearer remain server-side.
```

Update architecture diagram, prerequisites, environment table, commands, core
rules, troubleshooting, and security sections without promising Web Reader or PM
competitive-analysis output.

- [ ] **Step 3: Add AGENTS.md invariants**

Add a `### SearXNG MCP` section containing exact fixed ID/tool, input/output
bounds, fixed endpoint paths, server-owned variables, no redirects, safe errors,
read-only/open-world annotations, PM/stored-agent consumers, and the rule that
Garage remains exactly five tools.

Update local-state rules for `searxng/.env.local` and preserve every existing
architecture invariant.

- [ ] **Step 4: Update architecture and operations docs**

`docs/ARCHITECTURE.md` must show SearXNG service and data flow:

```text
PM Agent / selected stored agent
  -> search_web
  -> fixed in-process SearXNG MCP/client
  -> server-owned SearXNG endpoint
  -> configured external search engines
```

`docs/OPERATIONS.md` must document local/external configuration, loopback port,
health check, pinned image, generated secret handling, startup/conflict/timeout
troubleshooting, exact limits, optional bearer secrecy, and safe shutdown without
volume deletion.

- [ ] **Step 5: Run documentation and whitespace checks**

Run:

```bash
git grep -n "SEARXNG_SECRET" -- ':!docs/superpowers/specs/*' ':!docs/superpowers/plans/*'
git grep -n "search_web" README.md AGENTS.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git diff --check
```

Expected: `SEARXNG_SECRET` appears only where explicitly described as internal
local service state, never in application env examples; search contract appears
in all required docs; whitespace check exits 0.

- [ ] **Step 6: Commit documentation**

```bash
git add .env.example agent/.env.example README.md AGENTS.md docs/ARCHITECTURE.md docs/OPERATIONS.md
git commit -m "docs: document SearXNG search"
```

---

### Task 10: Full Verification, Independent Review, And Final Fixes

**Files:**
- Review: every file changed from branch base `91882fc...HEAD`
- Modify: only files required to fix verified findings

**Interfaces:**
- Produces a clean, reviewed feature branch. Does not push or create a PR.

- [ ] **Step 1: Refresh and report remote integration state without changing history**

Run:

```bash
git fetch --prune origin
git rev-list --left-right --count origin/main...HEAD
gh pr view 6 --json number,state,headRefOid,baseRefOid,mergeable,mergeStateStatus,updatedAt,url
```

Expected: commands report current divergence and PR #6 state. Do not merge,
rebase, reset, cherry-pick, or rewrite. Continue implementation verification
against branch base `91882fc`; include any new integration risk in final report.

- [ ] **Step 2: Reinstall exact dependencies**

Run: `npm ci`

Expected: install exits 0. Record existing audit findings separately; do not run
`npm audit fix` or change the lockfile unless a new feature dependency caused the
finding (none is planned).

- [ ] **Step 3: Run focused security/regression tests**

Run:

```bash
npx vitest run agent/src/config/env.test.ts agent/src/mastra/searxng/config.test.ts agent/src/mastra/searxng/client.test.ts agent/src/mastra/tools/searxng-search.test.ts agent/src/mastra/mcp/searxng-mcp-server.test.ts agent/src/mastra/mcp/garage-mcp-server.test.ts agent/src/agents/__tests__/both-agents.test.ts agent/src/__tests__/agent-routes.test.ts client/src/server/agent-payload.test.ts client/src/app/api/agent/[...path]/route.test.ts client/src/lib/ui-structure.test.ts scripts/dev.test.ts
```

Expected: all listed files PASS.

- [ ] **Step 4: Run required repository verification**

Run separately from repository root:

```bash
npm run check
npm run build
git diff --check 91882fc...HEAD
```

Expected: all commands exit 0. If build fails only because Mastra cannot reach
the npm registry, preserve source unchanged and capture exact external failure;
otherwise fix the regression before proceeding.

- [ ] **Step 5: Audit Git state and tracked files**

Run:

```bash
git status --short --branch
git diff --stat 91882fc...HEAD
git diff --name-only 91882fc...HEAD
git ls-files | rg "(^|/)(\.env($|\.)|mastra\.db|.*\.sqlite|node_modules|\.next|\.mastra|dist|coverage|searxng/\.env\.local|storage/\.garage|worktrees?)"
```

Expected: worktree clean; only intended source/test/config/docs files differ;
tracked-file audit contains no secrets, generated databases, Docker data, build
output, or worktree pointers.

- [ ] **Step 6: Request independent code review**

Dispatch a fresh reviewer against `91882fc...HEAD` with the approved spec.
Require findings in severity order and focus on:

```text
Critical/Important security defects
fixed MCP registry bypasses
SSRF/redirect/path construction
credential or endpoint leakage
timeout/body/output bound bypasses
stored-agent proxy bypasses
Garage/PM/approval regressions
launcher secret/process leaks
missing spec tests
```

- [ ] **Step 7: Fix all Critical and Important findings with TDD**

For each accepted finding, first add or tighten a regression test, run it to
observe failure, make the smallest fix, rerun the focused test, and commit with a
specific conventional message. Do not change behavior for style-only findings.

- [ ] **Step 8: Rerun complete verification after review fixes**

Run:

```bash
npm run check
npm run build
git diff --check 91882fc...HEAD
git status --short --branch
```

Expected: checks/build/whitespace pass and worktree is clean.

- [ ] **Step 9: Report completion without publishing**

Summarize implementation, exact verification results, independent-review
findings/fixes, remaining risks, current branch/worktree, commits, and changed
files. State explicitly that no push or PR was performed. Wait for explicit user
approval before either action.
