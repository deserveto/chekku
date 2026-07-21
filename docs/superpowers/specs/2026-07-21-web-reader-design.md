# Hosted Web Reader Design

## Status

Approved for implementation planning on 2026-07-21.

This specification covers one bounded public-page reader backed by hosted Jina
Reader. It does not add multi-page crawling, authenticated browsing, document
uploads, or PM competitive-analysis behavior.

## Goal

Add a secure built-in `web-reader` MCP capability to Chekku. PM Agent receives
the reusable `read_web_page` tool directly, while stored agents may select the
same fixed capability in Agent Builder.

The expected research flow is:

```text
search_web(query)
  -> bounded SearXNG result URLs and snippets
  -> agent selects a relevant public URL
  -> read_web_page(url)
  -> bounded untrusted Markdown from that one page
```

SearXNG answers which pages appear relevant. Web Reader answers what one chosen
page says. Neither tool performs competitive analysis. The later
`feat/pm-competitive-analysis` branch will orchestrate repeated searches and
reads across at least five products.

## Delivery Sequence And Branch

This is the second branch in the approved research sequence:

1. `feat/searxng-mcp`: merged as PR #7.
2. `feat/web-reader`: covered by this specification.
3. `feat/pm-competitive-analysis`: starts only after Web Reader merges.

`feat/web-reader` was created in an isolated worktree from updated
`origin/main` at `1451be8`, after PRs #6, #7, and #8 merged. It must not inherit
local `main` planning commits or continue from the old SearXNG feature branch.

## Existing Invariants

The implementation must preserve these boundaries from current `origin/main`:

- `agent/src/mastra/index.ts` remains the single Mastra composition root.
- Five code-defined agents and the `weekly-social-drafts` workflow remain
  registered.
- Garage remains a fixed in-process MCP with exactly its five generic object
  tools.
- SearXNG remains a fixed in-process MCP with exactly `search_web`.
- PM report tools remain private direct tools on PM Agent and never enter any
  generic MCP registry.
- All five code-defined agents retain shared Memory, token limiting, and the
  final character budget guard from `context-limit.ts`.
- No tool uses the removed approval/suspension path. Web reading runs directly.
- Stored-agent records contain only fixed built-in MCP IDs and `{ tools: {} }`
  selections. They never contain endpoints, commands, packages, headers,
  environment values, or credentials.
- Browser modules never receive provider credentials or import server-only
  storage/provider code.
- Search result URLs remain untrusted metadata until validated by the Web
  Reader boundary.
- The QA browser remains an automation facility, not the arbitrary-page reader
  security boundary.

Current `AGENTS.md` contains stale QA Android wording that says the global MCP
registry is fixed to Garage, despite runtime and tests already registering
Garage and SearXNG. Web Reader documentation must correct that statement while
adding the third fixed in-process MCP. It must not change Maestro's private
agent-only MCP behavior.

## Approaches Considered

### Hosted Jina Reader

Selected. Jina provides direct and browser rendering, Readability cleanup, and
Markdown conversion behind one fixed service. Chekku contacts only Jina rather
than arbitrary target hosts, which materially simplifies Chekku's local SSRF
boundary and avoids adding a browser/extraction stack.

Tradeoffs:

- target URLs and extracted public-page content pass through Jina;
- availability and quotas depend on an external provider;
- public documentation does not establish a Chekku-controlled SLA or retention
  guarantee;
- Jina's remote DNS, redirect, and network isolation remain provider
  responsibilities.

### Hosted Or Self-Hosted Firecrawl

Rejected for this branch. Firecrawl is stronger when multi-page crawl, map,
structured extraction, and asynchronous jobs are required. Those are explicitly
out of scope. Its self-hosted path adds services and does not include all hosted
Fire-engine capabilities.

### Local Node Fetch, Readability, And Browser Fallback

Rejected for the first release. It offers maximum local control but requires a
larger security and operations surface: DNS pinning, redirect-hop validation,
DNS rebinding defense, content decoding, HTML parsing, Readability, Markdown
conversion, and a browser fallback for JavaScript-heavy pages.

## Selected Architecture

Jina is an external HTTP API, not an MCP server in this design. Chekku wraps it
in a provider-neutral capability:

```text
hosted Jina Reader API
  <- fixed JinaReaderClient transport
  <- reusable read_web_page Mastra tool
  <- direct PM Agent tool registration
  <- fixed Chekku web-reader MCP for stored-agent hydration
```

The implementation has four backend units:

1. A public-URL validator owns syntax, scheme, credential, port, hostname, and
   literal-IP policy.
2. A Jina Reader client owns lazy server configuration, fixed provider request,
   deadline, bounded response reading, response normalization, and safe errors.
3. A reusable `read_web_page` Mastra tool owns the strict public input/output
   schemas and untrusted-content description.
4. An immutable `web-reader` `MCPServer` exposes exactly that tool for stored
   agents.

The public tool and MCP IDs remain provider-neutral. No provider selector,
fallback implementation, or remote MCP transport is exposed.

## Server Configuration

Application configuration adds only:

```text
WEB_READER_API_KEY
```

The provider endpoint is fixed in code to:

```text
https://r.jina.ai/
```

There is no `JINA_*` environment variable and no configurable Reader endpoint.
This follows the repository rule against provider-specific runtime variables
and prevents runtime endpoint substitution.

`WEB_READER_API_KEY` is required when `read_web_page` executes, but optional at
process startup. Chekku must boot with the tool registry intact when the key is
absent or malformed. Invocation then returns a fixed configuration error.

The key:

- is read only by the agent server;
- is trimmed once, must then be non-empty, and must contain no carriage return
  or line feed;
- is sent in normalized form only as `Authorization: Bearer <value>` to the
  fixed Jina endpoint;
- never enters a tool schema, stored-agent record, browser request, model input,
  tool output, log, public error, or documentation example value.

Chekku intentionally disables Jina's supported anonymous fallback. This avoids
an environment-dependent fallback to a lower and less predictable anonymous
quota.

## Capability Scope

The `web-reader` MCP registry contains exactly `read_web_page`.

The tool reads one public web page per invocation. It does not:

- discover URLs or replace `search_web`;
- crawl a site or follow page links recursively;
- read multiple URLs in one call;
- upload HTML, PDF, image, or office-document bytes;
- return screenshots, raw HTML, cookies, storage state, or browser diagnostics;
- authenticate to a target site;
- bypass robots policy, paywalls, bot protection, or access controls;
- accept custom headers, proxies, scripts, selectors, engines, locales, user
  agents, referers, cache controls, rendering controls, or provider prompts;
- persist, cache, summarize, compare, or otherwise interpret page content.

## Input Contract

The strict input object contains one field:

| Field | Required | Contract |
| --- | --- | --- |
| `url` | Yes | Trimmed absolute public HTTP(S) URL, at most 2,048 UTF-8 bytes. |

Unknown fields fail schema validation. In particular, input cannot contain a
provider endpoint, method, token, header, cookie, proxy, timeout, selector,
script, response format, target credentials, or raw body.

## Public URL Policy

Before contacting Jina, Chekku parses and normalizes the target with the WHATWG
`URL` implementation and enforces all of these rules:

- scheme is exactly `http:` or `https:`;
- username and password are empty;
- raw input contains no C0 control or DEL character before trimming or parsing;
- hostname is present;
- hostname has no terminal dot;
- explicit port is absent or is the scheme default (`80` for HTTP, `443` for
  HTTPS);
- hostname is not `localhost` and does not end in `.localhost`;
- hostname is not `local`, `internal`, or `home.arpa` and does not end in
  `.local`, `.internal`, or `.home.arpa`;
- literal IPv4 and IPv6 addresses must be globally routable;
- loopback, unspecified, private, shared, link-local, multicast, documentation,
  benchmarking, reserved, carrier-grade NAT, and IPv4-mapped non-public IPv6
  ranges are rejected;
- URL byte length remains within 2,048 after normalization.

Add `ipaddr.js` `^2.2.0` as a direct agent dependency for literal-IP parsing and
range classification. Its current transitive `1.9.1` presence does not count as
a supported direct dependency and lacks required benchmarking-range behavior.
Remove WHATWG's brackets from an IPv6 hostname before calling
`ipaddr.process()`, which also normalizes IPv4-mapped IPv6 before range checks.

Fragments are allowed because they may identify client-side routes. Jina's POST
URL submission is used so fragments are not lost as an HTTP request fragment.
Query strings are allowed because public pages often require them. In this
contract, `public` describes network reachability, not proof that a URL contains
no bearer material. Callers must not submit signed, OAuth, password-reset, or
otherwise secret-bearing URLs; Chekku cannot reliably infer secrets from query
or fragment names. Their values must never appear in public errors or logs.

Chekku does not resolve target DNS because Chekku never connects to the target.
Local resolution would not prove which address Jina resolves remotely and would
create a second network side effect. Jina owns provider-side DNS rebinding,
target redirects, and network isolation. Chekku must document this boundary and
must not claim end-to-end redirect or SSRF control inside Jina.

Jina's `data.url` is a provider-reported source URL, not evidence of the final
target after redirects. Chekku applies the same public URL policy to that value.
An unsafe or malformed source URL makes the provider response invalid, even
though the remote fetch has already occurred. Target redirect destinations
remain opaque to Chekku.

## Fixed Jina Request

For each valid invocation, Chekku sends exactly one request:

```text
POST https://r.jina.ai/
```

The JSON body contains exactly:

```json
{
  "url": "<normalized public URL>"
}
```

Fixed request headers are:

```text
Accept: application/json
Authorization: Bearer <server-owned key>
Content-Type: application/json
DNT: 1
X-No-Cache: true
X-Robots-Txt: true
X-Respond-With: markdown
X-Retain-Links: all
X-Timeout: 25
```

Jina may choose its direct or browser rendering engine. Chekku does not expose
that choice. Chekku also does not enable iframes, shadow DOM flattening, custom
scripts, screenshots, proxy routing, target cookies, storage export, generated
image descriptions, or structured extraction.

The HTTP client uses `redirect: 'error'` for redirects from the fixed Jina API
request itself. This is distinct from redirects that Jina follows internally
while fetching the target page.

## Deadline, Cancellation, And Bounds

One 30-second deadline covers configuration resolution, the Jina request, body
streaming, JSON parsing, and normalization. A caller abort signal may end the
operation earlier. Chekku issues no retry and no second provider request.

The client:

- requires a successful HTTP response;
- accepts `application/json` or `text/json` only;
- reads the body as a stream and cancels before retaining more than 2 MiB;
- decodes UTF-8 fatally;
- parses JSON as unknown input;
- never copies raw provider data into an error.

## Provider Response Contract

Current Jina JSON responses use this envelope:

```json
{
  "code": 200,
  "status": 20000,
  "data": {
    "title": "Example",
    "url": "https://example.com/",
    "content": "# Example\n..."
  }
}
```

Chekku accepts only a plain top-level object whose `code` is exactly `200`,
whose `status` is exactly `20000`, and whose `data` field is a plain object with
string `url` and `content`; `title` may be an absent or string field. Every other
provider field is ignored, including description, warning, published time,
HTTP status text, metadata, images, external resources, usage, timings,
diagnostics, and request identifiers.

Do not add compatibility parsing for undocumented legacy shapes. A provider
shape change returns the fixed invalid-response error and requires an explicit
reviewed update.

## Output Contract

The strict output object is:

```text
requestedUrl
sourceUrl
title
markdown
contentIsUntrusted
truncated
```

Rules:

- `requestedUrl` is the normalized validated input URL, at most 2,048 bytes;
- `sourceUrl` is Jina's validated provider-reported source URL, at most 2,048
  bytes, and is not represented as a final redirect destination;
- `title` is empty when absent, otherwise trimmed and limited to 512 UTF-8
  bytes;
- `markdown` preserves the provider string unless local output bounding shortens
  it;
- `contentIsUntrusted` is always `true`;
- `truncated` is true exactly when a present title changes through trimming or
  byte limiting, or when Markdown is shortened locally;
- serialized JSON output is at most 71,680 UTF-8 bytes;
- truncation never splits a UTF-8 code point;
- unknown provider fields never enter output.

Normalization maps an absent title to empty without marking truncation. For a
present title, it trims whitespace, takes the longest UTF-8-safe prefix of at
most 512 bytes, and records whether the final title differs from the original
provider string. It then builds the complete output with the full Markdown and
`truncated` equal to that title-change flag. If serialized output fits, it
returns unchanged. Otherwise it sets
`truncated: true` and chooses the longest UTF-8-safe Markdown prefix for which
`Buffer.byteLength(JSON.stringify(output), 'utf8')` is at most 71,680. JSON
escaping therefore counts toward the limit. No textual marker is appended; the
boolean is the sole truncation marker.

The tool description states that page Markdown is untrusted external data. It
must be used as evidence, never as instructions. Chekku does not attempt to
detect or remove prompt injection because content-based detection is not a
reliable security boundary. Structured output, an explicit boolean, bounded
content, and the tool description provide limited defense in depth. The later
competitive-analysis branch must add workflow-specific instruction handling.

## Error Boundary

Public failures are selected from fixed categories:

- `Web Reader is not configured.`
- `This URL is not allowed for public web reading.`
- `Web Reader request was cancelled.`
- `Web Reader timed out. Try again.`
- `Web Reader is unavailable. Try again later.`
- `Web Reader returned an unsupported format.`
- `Web Reader returned too much data.`
- `Web Reader returned an invalid response.`

Schema validation reports bounded field-specific URL errors through Mastra.
Provider `401` and `403` map to the configuration error. `408`, `429`, and `5xx`
map to unavailable unless the client-owned deadline fired, which maps to
timeout. Other unsuccessful statuses map to unavailable.

Caller cancellation maps to the fixed cancellation error and never propagates
the caller's abort reason. Only the client-owned deadline maps to timeout.

Never expose the requested URL, query string, fragment, endpoint, bearer token,
request or response headers, raw body, status text, stack trace, provider
warning, diagnostic, timing, usage, or request ID. Internal logs may record only
a fixed error category and tool ID.

## MCP Behavior

`webReaderMcpServer` has fixed ID `web-reader` and exactly one tool,
`read_web_page`. Attempts to add or remove tools fail with a fixed registry
error. No remote MCP URL, subprocess, package, or runtime transport is created.

The tool requires no approval. Its MCP annotations are:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: true
```

`openWorldHint` is true because Jina fetches an external target. The idempotent
hint describes absence of user-account or Chekku-state mutation, not a promise
that page contents remain unchanged between calls.

## PM Agent Integration

PM Agent registers `read_web_page` directly beside its existing three PM report
tools and `search_web`.

This branch does not change PM Agent instructions to require research,
competitive analysis, five products, repeated reads, citations, a feature
matrix, or report-format changes. Shared Memory, context limiter, final char
guard, report namespace, model, identity, description, and max-step budget stay
unchanged.

The stable direct tool registry allows the later competitive-analysis branch to
change only orchestration and output behavior after both capabilities merge.

## Stored-Agent And Proxy Contract

Agent Builder exposes three fixed MCP capabilities:

```text
garage
searxng
web-reader
```

A selected Web Reader persists only as:

```ts
mcpClients: {
  'web-reader': { tools: {} },
}
```

Valid records may select any non-empty subset of the three fixed IDs. Absence of
`mcpClients` means no selection. Every value remains a plain object whose only
key is `tools`, and `tools` remains a plain empty object.

The Next.js proxy validates stored-agent POST, PATCH, and PUT mutations after
path normalization. It rejects empty maps, unknown IDs, malformed values,
endpoints, URLs, commands, arguments, packages, environment values, credentials,
headers, provider options, tool overrides, and extra fields before forwarding.

Hydration reads only recognized IDs. Agent Builder renders a fixed Web Reader
card and exposes no provider status, endpoint, token, header, or advanced Jina
control.

## Testing Strategy

Implementation follows regression-first TDD. Every behavior starts with a
focused failing Vitest test, then receives the smallest production change.

### Configuration and lazy startup

- Empty or malformed key never breaks module import or Mastra startup.
- Missing/malformed key fails only when the tool executes.
- Valid key produces one bearer header without appearing in output or errors.
- No `JINA_*`, endpoint, or browser-exposed environment field is accepted.

### Public URL validation

- Accept ordinary HTTP/HTTPS URLs, query strings, fragments, Unicode hostnames,
  and default ports.
- Reject unsupported schemes, relative URLs, credentials, control characters,
  overlong URLs, missing hosts, terminal-dot hosts, and non-default ports.
- Reject raw control characters in host, path, query, or fragment before WHATWG
  parsing can normalize them away.
- Reject localhost aliases and every non-public IPv4/IPv6 category, including
  bracketed/mapped forms and unusual WHATWG-normalized IPv4 syntax.
- Reapply policy to Jina's provider-reported source URL without describing it as
  a final redirect URL.

### Fixed transport and secrecy

- POST only to `https://r.jina.ai/` with exact JSON body and fixed headers.
- Prove caller input cannot add headers, cookies, proxy, script, engine,
  selector, timeout, cache, or format controls.
- Reject provider redirects.
- Combine caller cancellation with one 30-second deadline.
- Enforce JSON MIME and 2 MiB streaming cap.
- Map missing key, auth, timeout, abort, HTTP, MIME, size, UTF-8, and malformed
  JSON failures to fixed errors.
- Prove URL, token, provider body, headers, diagnostics, and IDs never appear in
  errors or logs.

### Response normalization

- Require exact success `code` and `status`, then accept the documented `data`
  object and only title, URL, and content strings.
- Reject direct/legacy or malformed envelopes.
- Ignore warning, metadata, resources, usage, timing, and diagnostics.
- Enforce source public URL, title, Markdown, and 71,680-byte serialized output
  bounds with UTF-8-safe deterministic truncation after JSON escaping.
- Always return `contentIsUntrusted: true`.

### Tool, MCP, runtime, and PM Agent

- Enforce exact URL-only schema and reject every extra input field.
- Preserve exact annotations and no-approval behavior.
- Register fixed MCP ID with exactly `read_web_page`; reject mutation.
- Register Garage, SearXNG, and Web Reader in the one composition root.
- Preserve all five agents and `weekly-social-drafts`.
- Preserve exact Garage and SearXNG registries.
- Preserve PM report behavior and instructions while adding the direct reader
  tool.
- Preserve shared context-limit processor order.

### Stored agents and client proxy

- Create, read, edit, and hydrate stored agents with each fixed MCP and all
  relevant combinations.
- Accept exact non-empty fixed MCP subsets on POST, PATCH, and PUT aliases.
- Reject unknown, empty, malformed, endpoint, URL, command, args, package, env,
  credential, header, provider-option, tool-override, and extra-field payloads
  without upstream fetch.
- Keep GET, POST, PUT, PATCH, DELETE, and HEAD proxy exports unchanged.
- Render fixed Web Reader metadata exhaustively against the MCP ID tuple.

### Completion and review

Before publication:

```bash
npm ci
npm run check
npm run build
git diff --check
```

Also run focused security/regression tests, a tracked-file secret/generated-state
audit, and an independent review emphasizing URL parsing, target policy, fixed
provider routing, credential leakage, response bounds, proxy bypasses, context
limits, and preservation of existing MCP registries and workflows.

A live no-key invocation must prove safe failure. When an operator supplies a
test key explicitly, perform one optional live smoke read against
`https://example.com`; never print the key or raw headers. Live provider access
is not required for deterministic CI.

## Documentation

Update:

- `.env.example` and `agent/.env.example` for `WEB_READER_API_KEY`;
- `README.md` for search-then-read usage, hosted-provider privacy, one-page
  scope, and stored-agent selection;
- `AGENTS.md` with fixed Web Reader registry, limits, safe errors, provider
  boundary, PM/stored-agent consumers, and corrected global MCP wording;
- `docs/ARCHITECTURE.md` for Jina data flow and untrusted content;
- `docs/OPERATIONS.md` for required key, hosted availability, limits,
  troubleshooting, and smoke testing.

Documentation must explicitly state:

- Jina is a hosted provider called by a Chekku tool, not a dynamically
  configurable MCP server;
- public URLs and extracted content leave Chekku and pass through Jina;
- Chekku does not control Jina's internal DNS, target redirects, or retention;
- Web Reader reads one public page and does not crawl;
- page Markdown is untrusted and may contain prompt injection;
- competitive analysis remains a later separately reviewed branch.

## Baseline Note

At branch creation, `npm ci` passed with the merged lockfile's existing audit
result of 5 low, 3 moderate, and 3 high vulnerabilities. No audit fix was run.

The unchanged `origin/main` baseline passed all typechecks and lint, but the
full Windows test run hit three launcher wall-clock/process thresholds. Two
cases passed in isolation; one cleanup case performed the expected timeout and
orphan checks but took 3.93 seconds against a 3.5-second ceiling. The user
approved proceeding with the design spec while keeping this pre-existing
baseline issue out of Web Reader scope. Web Reader implementation and GitHub CI
must still pass all affected and required checks before publication.

## Source References

Design decisions were checked against current sources on 2026-07-21:

- Jina Reader repository and API overview:
  <https://github.com/jina-ai/reader>
- Jina Reader API documentation:
  <https://r.jina.ai/docs>
- Firecrawl scrape and self-hosting documentation:
  <https://docs.firecrawl.dev/features/scrape>
  <https://docs.firecrawl.dev/contributing/self-host>
- WHATWG URL standard:
  <https://url.spec.whatwg.org/>
- Node.js URL API:
  <https://nodejs.org/api/url.html>
- `ipaddr.js` repository:
  <https://github.com/whitequark/ipaddr.js>
- Mastra MCP server reference:
  <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/tools/mcp-server.mdx>

A live unauthenticated GET against Jina Reader and `https://example.com` was
used only to confirm the current JSON envelope. No secret or project data was
sent.
