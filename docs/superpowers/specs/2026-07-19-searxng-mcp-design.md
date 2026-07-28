# Built-in SearXNG MCP Design

## Status

Approved for implementation planning on 2026-07-19.

This specification covers the SearXNG search foundation only. It does not
include arbitrary page fetching or PM competitive-analysis behavior.

## Goal

Add SearXNG as a secure built-in Chekku MCP capability. PM Agent receives the
search tool directly, while stored agents may select the same capability in
Agent Builder. Browser and model inputs can select only fixed built-in MCP IDs;
they can never configure an endpoint, command, package, environment variable,
header, or credential.

The first release exposes one read-only tool that finds relevant sites and
returns bounded search metadata and snippets. It does not download result-page
content.

## Delivery Sequence

The broader supervisor request is split into three sequential independent
branches and reviews:

1. `feat/searxng-mcp`: built-in SearXNG search, covered by this spec.
2. `feat/web-reader`: hardened page-reading service and tool, specified after
   SearXNG merges.
3. `feat/pm-competitive-analysis`: PM Agent workflow for finding at least five
   similar products, analyzing each product, and producing a feature comparison,
   specified after both research capabilities merge.

Each later branch starts from updated `origin/main` after its dependency merges.
This keeps search integration, arbitrary-URL security, and PM output behavior in
separate review scopes.

The SearXNG branch and worktree start from `origin/main`, not local `main`.
Local `main` and its three planning commits remain unchanged and do not enter the
SearXNG feature history.

## Existing Invariants

The change must preserve these boundaries:

- `agent/src/mastra/index.ts` remains the single Mastra composition root.
- `mainAgent`, `pmAgent`, `qaWebAgent`, and `socialMediaAgent` remain registered.
- Garage remains registered under `garage` and exposes exactly
  `create_text_object`, `get_text_object`, `list_text_objects`,
  `replace_text_object`, and `delete_object`.
- PM report tools remain code-defined on PM Agent and never enter Garage MCP or
  SearXNG MCP.
- Memory, model gateway normalization, thread ownership, identity, proxy method
  support, browser approvals, Telegram integration, and email approval behavior
  remain intact.
- Browser modules receive no MCP endpoint or credential data.
- PR #6 overlaps runtime registration, approvals, tests, and documentation. Its
  changes are not silently incorporated. Any later reconciliation requires a
  fresh diff against the merged base and must preserve the active requirements.

## Selected Architecture

Chekku implements a small in-process Mastra `MCPServer`. It does not execute a
community MCP package or add a second Chekku search gateway service.

The implementation has three focused backend units:

1. A SearXNG HTTP client owns server configuration, fixed URL construction,
   capability validation, timeouts, bounded body reads, response normalization,
   and safe error mapping.
2. A reusable Mastra `search_web` tool owns the public input and output schemas.
3. A fixed `searxng` `MCPServer` exposes exactly that tool and rejects dynamic
   registry mutation.

The same tool action is registered directly on PM Agent. The MCP server is
registered on the Mastra instance for stored-agent hydration. This avoids two
search implementations while preserving the distinction between code-defined
PM tools and selectable stored-agent MCP capabilities.

## Server Configuration

Application configuration uses only:

```text
SEARXNG_BASE_URL
SEARXNG_API_KEY
```

`SEARXNG_BASE_URL` is optional at process startup so Chekku still boots without
SearXNG. `search_web` returns a fixed configuration error when it is absent.

The base URL:

- must use `http` or `https`;
- must not contain a username, password, query, or fragment;
- may contain a deployment path prefix;
- is normalized with one trailing slash before fixed relative paths are joined.

For example, `https://search.example.test/private/` produces only
`https://search.example.test/private/config` and
`https://search.example.test/private/search`.

`SEARXNG_API_KEY` is optional. When present, Chekku sends it only as
`Authorization: Bearer <value>` to the configured SearXNG endpoint. The value
must not contain CR or LF. Arbitrary authentication headers are out of scope.

Neither value is accepted through a tool schema, stored-agent record, browser
request, or Agent Builder field.

## Local SearXNG Service

Root `compose.yaml` gains an official SearXNG service with these properties:

- image `docker.io/searxng/searxng:2026.7.18-277d8469c`;
- container port `8080` published only as `127.0.0.1:8888`;
- tracked `searxng/settings.yml` mounted read-only;
- named cache volume mounted at `/var/cache/searxng`;
- container healthcheck against `/healthz` without a host `curl` dependency;
- no Valkey service because local limiter support is disabled.

Tracked settings extend SearXNG defaults and explicitly set:

```yaml
use_default_settings: true
general:
  instance_name: Chekku Search
  debug: false
  enable_metrics: false
search:
  safe_search: 1
  autocomplete: ""
  max_page: 5
  formats:
    - html
    - json
server:
  limiter: false
  public_instance: false
  image_proxy: false
  method: POST
outgoing:
  request_timeout: 5.0
  max_request_timeout: 10.0
```

SearXNG's cryptographic `SEARXNG_SECRET` is service-internal. It is generated
locally and never becomes application configuration.

## Local Environment And Launcher

`scripts/searxng-env.sh` is responsible only for local SearXNG state. It:

- runs with `umask 077`;
- creates ignored `searxng/.env.local` atomically when absent;
- generates a stable random `SEARXNG_SECRET`;
- records a hash of tracked SearXNG settings so Compose recreates the service
  when configuration changes;
- exports local `SEARXNG_BASE_URL=http://127.0.0.1:8888` and an empty
  `SEARXNG_API_KEY` for application launch;
- never prints secrets.

Existing `scripts/storage-env.sh` remains responsible for Garage. `scripts/dev.sh`
sources Garage and SearXNG helpers in a fixed order, validates the complete
Compose configuration before inspecting or starting services, and renders the
generated `agent/.env.development` safely.

Generated `agent/.env.development` contains exactly five `GARAGE_*` application
values plus:

```text
SEARXNG_BASE_URL
SEARXNG_API_KEY
```

Mastra receives those seven application values. Next.js receives the five
Garage values needed by its server-only PM report boundary, but the launcher
removes every `SEARXNG_*` value before starting the client process. Neither
process receives `SEARXNG_SECRET`, the settings hash, or unrelated `SEARXNG_*`
values. The local launcher intentionally overrides an external SearXNG value
from `agent/.env`; operators who use an external endpoint run the normal agent
process with server-owned environment configuration instead of the local
infrastructure launcher.

The launcher:

- detects port conflicts for Garage `3900` and SearXNG `8888` before starting an
  absent service;
- starts or recreates only services whose runtime/configuration requires it;
- waits for both service healthchecks under the existing bounded ready timeout;
- reports service-specific, secret-free startup and timeout errors;
- starts Mastra and Next.js only after both services are healthy;
- retains bounded process-tree cleanup in Windows Git Bash and Linux.

Generated SearXNG environment and local state remain ignored. Named Docker
volumes are not deleted by normal launcher or reset instructions.

## `search_web` Input Contract

The fixed MCP registry contains exactly `search_web`.

Input fields are:

| Field | Required | Contract |
| --- | --- | --- |
| `query` | Yes | Trimmed non-empty text, at most 1,024 UTF-8 bytes. |
| `maxResults` | No | Integer 1-20; default 10. |
| `page` | No | Integer 1-5; default 1. |
| `language` | No | One language supported by sanitized instance capabilities. |
| `categories` | No | Unique list of at most 5 configured category names. |
| `engines` | No | Unique list of at most 10 enabled configured engine names. |
| `safeSearch` | No | Integer enum `0`, `1`, or `2`. |
| `timeRange` | No | Enum `day`, `month`, or `year`. |

No input field accepts endpoint, path, URL, HTTP method, header, token, command,
package, environment variable, response format, timeout, or raw form data.

## Capability Validation

SearXNG exposes current instance information at fixed `/config`. Chekku requests
that endpoint only when `language`, `categories`, or `engines` needs validation.
A query using instance defaults can still run when optional targeting is absent.

The client normalizes only:

- top-level configured categories;
- enabled engine names;
- language identifiers derived from engine language support and configured
  locales, plus SearXNG's `all` and `auto` values.

Capability responses use the same 12-second request deadline, JSON MIME check,
2 MiB body cap, redirect rejection, and safe error mapping as search responses.
Successful normalized capabilities are cached for five minutes. Failed or
malformed responses are not cached. Unknown targeting values fail before the
search request and do not get forwarded upstream.

## Search Request Flow

For each valid invocation:

1. Resolve validated server configuration.
2. Validate optional instance-specific targeting against cached capabilities.
3. Construct only the fixed `/search` URL.
4. Send an `application/x-www-form-urlencoded` POST containing `q`,
   `format=json`, and approved optional parameters.
5. Attach the optional server-owned bearer token.
6. Reject every redirect, including external-bang redirects derived from a
   query.
7. Abort after 12 seconds, also honoring an earlier caller abort signal.
8. Require a successful JSON response and stop streaming after 2 MiB.
9. Parse the body as unknown input and normalize only approved output fields.

SearXNG does not offer a result-count request parameter. `maxResults` therefore
controls deterministic slicing after one requested search page is received.
The tool never fetches additional pages automatically.

## Output Contract

Output includes:

```text
query
page
results
answers
corrections
suggestions
truncated
```

Each result may contain only:

```text
url
title
snippet
engines
category
score
publishedAt
```

Normalization rules:

- only valid `http` and `https` result URLs are returned;
- URLs are limited to 2,048 UTF-8 bytes;
- titles are limited to 512 UTF-8 bytes;
- snippets are limited to 4,096 UTF-8 bytes;
- each result carries at most 8 unique engine names of at most 128 UTF-8 bytes;
- categories are limited to 128 UTF-8 bytes;
- scores must be finite numbers;
- valid published dates are returned as ISO strings; invalid dates are omitted;
- at most 5 answers are returned, each at most 2,048 UTF-8 bytes;
- at most 10 corrections and 10 suggestions are returned, each at most 512
  UTF-8 bytes.

After field and list normalization, serialized UTF-8 output is capped at
131,072 bytes. If needed, trailing auxiliary entries and then trailing results
are removed deterministically until the output fits. `truncated` is true when
the upstream result set exceeds `maxResults`, an invalid result is omitted, any
field/list is shortened, or final output pruning occurs.

Raw response objects, engine diagnostics, timing headers, provider request IDs,
and unresponsive-engine exception details are never returned.

## MCP Behavior

`searxngMcpServer` has fixed ID `searxng` and exactly one tool. Attempts to add
or remove tools fail with a fixed registry error. No arbitrary MCP transport is
created.

`search_web` does not require approval. Its MCP annotations are:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: true
```

`openWorldHint` is true because SearXNG sends the query to configured external
search engines. The operation does not mutate Chekku state or a user account.

## Error Boundary

Public failures are selected from fixed actionable categories:

- SearXNG search is not configured.
- Search targeting is not supported by the configured SearXNG instance.
- SearXNG search timed out. Try again.
- SearXNG search is unavailable. Try again later.
- The configured SearXNG instance does not provide JSON search.
- SearXNG returned too much data.
- SearXNG returned an invalid response.

Schema validation reports bounded field-specific input errors through Mastra.
HTTP status text, endpoint values, bearer tokens, request/response headers, raw
bodies, upstream diagnostics, stack traces, and provider request IDs are never
copied into tool errors. Internal logging may record a fixed error category but
must not record query text, endpoint, token, raw body, or upstream headers.

## Mastra And PM Agent Integration

`agent/src/mastra/index.ts` registers:

```ts
mcpServers: {
  garage: garageMcpServer,
  searxng: searxngMcpServer,
}
```

PM Agent registers `search_web` directly alongside its existing report tools.
The search tool is always present, including when SearXNG is unconfigured, so
the code-defined tool registry is stable across environments. An invocation in
an unconfigured environment returns the fixed configuration error.

This branch does not yet change PM Agent instructions to promise competitive
analysis, require five products, fetch source pages, or render a feature matrix.
Those behaviors belong to the third branch after the Web Reader exists.

## Stored-Agent And Proxy Contract

Agent Builder exposes fixed capabilities `garage` and `searxng`. A selected MCP
capability persists only as:

```ts
mcpClients: {
  [fixedId]: { tools: {} },
}
```

Valid records may select Garage only, SearXNG only, or both. No `mcpClients`
field represents no selection. If the field is present, it must be a non-empty
subset of the two fixed IDs.

For every entry:

- the value is a plain non-null object;
- its only key is `tools`;
- `tools` is a plain empty object.

The Next.js proxy applies this validation to stored-agent POST, PATCH, and PUT
mutations after path normalization. It rejects empty MCP maps, unknown IDs,
URLs, commands, arguments, packages, environment values, credentials, headers,
tool overrides, and every extra field before forwarding.

Hydration reads only recognized IDs. Agent Builder renders separate descriptive
cards for Garage and SearXNG and can create or edit agents with either or both.
It exposes no endpoint, token, server command, package, or environment control.

## Testing Strategy

Implementation follows TDD. Each behavior begins with a focused failing Vitest
test, the expected failure is observed, then minimal production code is added.

### HTTP client and configuration

- Accept HTTP/HTTPS base URLs and deployment subpaths.
- Reject embedded credentials, query, fragment, unsupported protocols, and
  bearer values containing line breaks.
- Construct only fixed `/config` and `/search` paths.
- Encode search as POST form data with `format=json`.
- Add optional bearer authentication without exposing it.
- Reject redirects.
- Combine caller cancellation with the 12-second deadline.
- Enforce JSON MIME and 2 MiB streaming bounds.
- Map timeout, HTTP, unsupported format, oversized body, and malformed JSON to
  fixed errors.
- Prove endpoint, token, headers, body, and diagnostics never appear in errors.

### Validation and normalization

- Enforce every input byte/count/range limit.
- Cache only successful sanitized capabilities for five minutes.
- Accept configured languages/categories/enabled engines and reject unknown or
  disabled values before search.
- Normalize approved result fields only.
- Omit invalid/non-HTTP(S) URLs and invalid optional fields.
- Enforce result, auxiliary-list, field, and 131,072-byte output limits.
- Set `truncated` for every shortening or omission case.

### MCP and runtime

- Register fixed MCP ID `searxng` with exactly `search_web`.
- Preserve exact annotations and no-approval behavior.
- Reject dynamic tool add/remove operations.
- Fail safely when unconfigured.
- Register SearXNG in the one Mastra composition root.
- Retain all existing code-defined agents.
- Prove Garage still exposes exactly its unchanged five tools and no PM/SearXNG
  behavior.
- Prove PM Agent retains its three PM report tools and gains `search_web` without
  changing report namespaces or approval behavior.

### Stored agents and client proxy

- Create, read, and hydrate stored agents with Garage, SearXNG, both, or neither.
- Preserve either/both selections through Agent Builder edit hydration.
- Accept exact non-empty fixed MCP subsets on normalized and aliased POST/PATCH/
  PUT routes.
- Reject empty, unknown, malformed, URL, command, args, package, env, credential,
  header, tool-override, and extra-field payloads without upstream fetch.
- Keep GET, POST, PUT, PATCH, DELETE, and HEAD proxy exports unchanged.

### Compose and launcher

- Pin the approved official image tag.
- Publish only loopback port 8888 and keep SearXNG internals private.
- Enable JSON and approved secure local settings.
- Generate stable private secrets without output leakage.
- Ignore generated environment and local state paths.
- Validate complete Compose configuration before service inspection/startup.
- Detect Garage and SearXNG port conflicts independently.
- Wait for both services under bounded readiness timing.
- Recreate SearXNG when its tracked configuration hash changes.
- Pass approved Garage and SearXNG values to Mastra, while proving Next.js
  receives no `SEARXNG_*` values.
- Preserve process-group cleanup on Windows Git Bash and Linux.

### Regression and completion

Run affected focused tests throughout development. Before completion:

```bash
npm ci
npm run check
npm run build
git diff --check
```

Request independent review of the complete diff against this spec. Fix all
Critical and Important findings, rerun full verification, and audit tracked files
for secrets, generated databases, Docker state, build output, and worktree
pointers.

## Documentation

Update:

- `.env.example` and `agent/.env.example` for the two server-owned application
  variables;
- `.gitignore` for generated SearXNG local state;
- `README.md` for local startup, capability selection, and search-only scope;
- `AGENTS.md` with fixed SearXNG registry and security invariants;
- `docs/ARCHITECTURE.md` for runtime, PM Agent, stored-agent, and data flow;
- `docs/OPERATIONS.md` for local/external deployment, health, configuration,
  troubleshooting, and reset behavior.

Documentation must explicitly state that SearXNG discovers pages and returns
snippets but does not read arbitrary result content. It must identify Web Reader
and PM competitive analysis as later separately reviewed features.

## Source References

Design decisions were checked against current sources on 2026-07-19:

- SearXNG Search API: <https://docs.searxng.org/dev/search_api.html>
- SearXNG container installation: <https://docs.searxng.org/admin/installation-docker.html>
- SearXNG search settings: <https://docs.searxng.org/admin/settings/settings_search.html>
- SearXNG server settings: <https://docs.searxng.org/admin/settings/settings_server.html>
- SearXNG outgoing settings: <https://docs.searxng.org/admin/settings/settings_outgoing.html>
- Current SearXNG web application routes, including `/healthz`, `/config`,
  `/autocompleter`, and `/search`:
  <https://github.com/searxng/searxng/blob/master/searx/webapp.py>
- Mastra `MCPServer` reference:
  <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/tools/mcp-server.mdx>
- Mastra MCP registration overview:
  <https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/mcp/overview.mdx>

The selected SearXNG image tag was verified to exist for amd64, arm64, and arm/v7
before this spec was written.
