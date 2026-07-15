# Final Review Fix Report

## Status

`DONE_WITH_CONCERNS`

Implementation commit: `a63531c fix: close Garage final-review gaps`

Concern: Garage v2.3.0 does not implement destination conditional PUT or DELETE requests. Chekku now provides the strongest truthful local guarantee, but cannot provide cross-process compare-and-swap behavior against external Garage writers.

## Finding 1: Trusted Stored-Agent MCP Validation

Disposition: fixed.

- Observed installed `@mastra/client-js` requests directly: create uses `POST /stored/agents`; update uses `PATCH /stored/agents/:id`.
- Added proxy-boundary validation for those routes and defensive `PUT /stored/agents/:id` handling.
- `mcpClients` must be absent or exactly `{ "garage": { "tools": {} } }`.
- Empty objects, additional clients, URLs, commands, arguments, environment variables, packages, credentials, malformed JSON, and extra Garage fields are rejected with HTTP 400 before `fetch`.
- Builder payloads now omit `mcpClients` when Garage is not selected.
- Existing GET, POST, PUT, PATCH, DELETE, HEAD exports and upstream response streaming remain intact.

TDD evidence:

- RED: proxy tests reached mocked upstream for five adversarial payloads; deselected builder payload contained `mcpClients: {}`.
- GREEN: 19 focused proxy/payload/path tests passed.

## Finding 2: Replace/Delete Races And Garage Conditions

Disposition: accepted with provider limitation; strongest spec-correct alternative implemented.

Evidence:

- Installed `@aws-sdk/client-s3` is 3.1087.0 and types expose `IfMatch` for `PutObjectCommand` and `DeleteObjectCommand`.
- Pinned Garage source tag v2.3.0 was inspected at `src/api/s3/put.rs` and `src/api/s3/delete.rs`.
- Garage v2.3.0 does not read destination `If-Match` or `If-None-Match` in PUT and does not read `If-Match` in DELETE. Conditional handling exists for GET/COPY only.
- Sending SDK condition fields would therefore invent safety Garage does not enforce.

Implementation:

- Same-key create, replace, and delete operations are serialized per adapter instance.
- Existence is checked immediately inside the serialized mutation.
- Create retains `IfNoneMatch: '*'` for S3-compatible providers that enforce it and adds the serialized Garage fallback.
- Replace and delete do not send misleading unsupported `IfMatch` fields.
- Documentation explicitly states external writers can still race Garage v2.3.0 operations.

TDD evidence:

- RED: delayed replace plus concurrent delete allowed stale PUT resurrection.
- RED: Garage-style ignored conditional PUT allowed create over an existing object.
- GREEN: adapter and namespace suites passed 54 tests, including serialized stale-race and create-fallback regressions.

## Finding 3: NoSuchBucket Classification

Disposition: fixed.

- Configuration identities are classified before generic HTTP 404 handling.
- `NoSuchBucket` now returns safe actionable code `configuration` and message `Garage object storage is not configured.`
- Provider body, endpoint, credentials, headers, and request IDs remain hidden.

TDD evidence:

- RED: `exists()` resolved `false` for `NoSuchBucket` with HTTP 404.
- GREEN: regression rejects with safe configuration error.

## Finding 4: Compose Port Exposure

Disposition: fixed.

- Compose publishes only `127.0.0.1:3900:3900`.
- Garage RPC 3901, admin 3902, and metrics 3903 remain container-internal.
- Launcher conflict detection and messages now require only host S3 port 3900.
- README and operations documentation describe loopback-only exposure.

TDD evidence:

- RED: committed runtime test found four wildcard host mappings.
- GREEN: runtime test proves one loopback mapping and no 3901-3903 mappings.

## Finding 5: Fallback Process Cleanup

Disposition: fixed.

- Fallback process groups receive TERM.
- Launcher polls both groups for bounded grace, default two seconds and configurable from 1-30 with `CHEKKU_TERM_GRACE_SECONDS`.
- Surviving groups receive KILL before waits complete.
- First exiting application status remains preserved.

TDD evidence:

- RED: TERM-resistant descendant caused launcher test to hit its 15-second timeout.
- GREEN: TERM-resistant process-tree regression completes with status 7, within four seconds, and confirms descendant no longer exists.
- Bash syntax validation passed.

## Finding 6: Hydrated Approval Lifecycle

Disposition: verified; realistic lifecycle coverage added.

- Tests create stored agents through `MastraEditor`, hydrate Garage tools through registered MCP server, install deterministic V2 models on hydrated agents, and execute real Mastra generate/suspend/resume APIs.
- Hydrated `replace_text_object` suspends; decline preserves original object and performs zero effective mutation.
- Hydrated `delete_object` suspends; object remains before approval and is deleted only after `approveToolCallGenerate`.
- These lifecycle tests passed on first execution, showing conversion already preserved approval behavior. Finding was a coverage gap, not a reproduced production defect, so no fabricated RED was claimed.

## Verification

- Focused proxy/payload/path: 19 passed.
- Focused storage/namespace: 54 passed.
- Focused MCP/tool approval: 15 passed.
- Full launcher: 19 passed.
- `npm run check`: typecheck and lint passed; 31 test files, 187 tests passed.
- `npm run build`: Mastra and Next.js production builds passed.
- `git diff --check`: passed.
- Generated `client/next-env.d.ts` build change was restored and excluded.
- No push performed.

## Self-Review

- No unresolved Critical or High implementation defect found.
- Proxy validation applies only to actual installed stored-agent mutation paths and does not buffer GET/HEAD or alter response streaming.
- Mutation queue releases on success and failure and removes idle keys.
- No unsupported ETag compatibility was invented.
- Remaining cross-process race is documented Garage v2.3.0 capability limit.

## Re-Review Fixes

Status: `DONE_WITH_CONCERNS`.

### Proxy Alias Authorization

- Verified `buildAgentProxyUrl` accepts both `stored/agents` and leading `api/stored/agents`; both resolve to upstream `/api/stored/agents`.
- Root cause: MCP authorization classified raw catch-all segments while URL forwarding normalized them.
- Added shared `normalizeAgentProxyPath`; proxy URL construction and authorization now use the same canonical path.
- Added adversarial alias tests for POST with MCP URL, PATCH with command/package arguments, and PUT with credentials. All reject before upstream fetch.
- Added POST, PATCH, and PUT alias tests for exact `{ garage: { tools: {} } }` forwarding and streamed response preservation.
- Existing GET, POST, PUT, PATCH, DELETE, and HEAD exports remain unchanged.

TDD evidence:

- RED: all three forbidden leading-`api` alias requests reached mocked upstream and failed while reading its undefined response.
- GREEN: focused proxy/path/payload suite passed 25 tests.

### README Storage Guarantee

- Removed the claim that create is conditionally safe on Garage v2.3.
- README now matches architecture and operations documentation: same-key mutations serialize only within one adapter instance, existence is checked immediately, and external Garage writers can race.

### Re-Review Verification

- Client typecheck: passed.
- Client lint: passed.
- `npm run check`: 31 test files and 193 tests passed.
- `npm run build`: Mastra and Next.js builds passed.
- `git diff --check`: passed before report append; final commit diff rechecked before commit.
- Generated `client/next-env.d.ts` build change restored and excluded.
- No push performed.

Concern remains unchanged: Garage v2.3 lacks destination conditional PUT/DELETE semantics, so cross-process or external-writer compare-and-swap cannot be guaranteed.
