# Generic Garage MCP And PM Branch Redesign

## Goal

Replace current overlapping PM branches with two sequential, reviewable branches:

1. A reusable, agent-isolated Garage MCP foundation.
2. PM Agent report functionality built on that foundation.

Garage MCP must be useful to agents beyond PM Agent. PM-specific report behavior must remain outside the generic MCP server.

## Git Safety Constraint

Local file changes, branches, and commits may proceed without additional approval. Ask for explicit user approval immediately before every push. Closing pull requests, deleting branches, or rewriting published history also requires explicit confirmation.

Implementation may be prepared, verified, and committed locally in an isolated worktree. Nothing is pushed without user approval.

Existing branches and pull requests remain untouched while replacement work is prepared:

- `feat/pm-agent-local-reports` and PR #1
- `feat/pm-agent-garage-storage` and PR #2
- `feat/top-level-garage-storage`

## Branch Structure

### Branch 1: Generic Garage Foundation

`feat/generic-garage-mcp` starts from current `origin/main` and contains:

- shared storage workspace and Garage/S3 adapter;
- agent-isolated object namespace support;
- generic Garage MCP text-object tools;
- stored-agent Garage capability selection;
- local Garage Compose and development launchers;
- environment, architecture, and operations documentation;
- focused tests plus full repository verification.

### Branch 2: PM Reports

`feat/pm-agent-garage-reports` starts from the approved generic Garage branch and contains:

- PM Agent;
- PM report repository and PM-specific tools;
- report APIs and report pages;
- clickable report links in chat;
- PM-specific tests and documentation.

The PM branch initially targets the generic branch. After the generic branch merges, the PM branch is rebased onto updated `main` and its pull request is retargeted to `main`.

## Generic Garage MCP Boundary

Garage MCP exposes only generic UTF-8 text-object operations:

- `create_text_object`
- `get_text_object`
- `list_text_objects`
- `replace_text_object`
- `delete_object`

PM-specific tools such as save, list, and view PM reports are not registered on Garage MCP. They remain code-defined PM Agent tools.

## Agent Isolation

Every generic Garage operation derives its namespace from trusted Mastra execution context at `context.agent.agentId`. Agent identity is never accepted from model-generated tool input.

Physical object keys use this shape:

```text
agents/<encoded-agent-id>/<validated-relative-key>
```

Tool responses expose relative keys only. They do not reveal or accept another agent's physical namespace.

Calls without trusted agent context fail closed. An agent cannot read, list, replace, or delete objects belonging to another agent.

## Object Validation

Relative object keys must:

- be non-empty;
- use forward slashes;
- reject absolute paths, backslashes, traversal segments, control characters, and empty path segments;
- remain at or below 512 UTF-8 bytes;
- preserve a stable canonical representation.

Text payloads are limited to 256 KiB measured as UTF-8 bytes. List results return at most 100 relative keys and include a `truncated` flag when more matching keys exist. Inputs receive strict schema validation before storage access.

## Write Safety

`create_text_object` creates a new key with a conditional storage write and fails if that key already exists. The existence check and write must not be separate race-prone operations.

`replace_text_object` updates an existing key and requires explicit user approval.

`delete_object` removes an existing key and requires explicit user approval.

`get_text_object` and `list_text_objects` are read-only. MCP annotations describe read-only, destructive, idempotent, and closed-world behavior accurately.

Shared object storage gains explicit existence and deletion operations instead of inferring all behavior from error strings. Garage/S3 errors remain actionable without exposing credentials, endpoint secrets, or raw provider responses.

## PM Report Integration

PM Agent owns its report semantics and tools:

- `save_pm_report_to_garage`
- `list_pm_reports_from_garage`
- `view_pm_report_from_garage`

PM tools and server-only report pages use the same fixed `pm-agent` namespace through the shared namespaced storage layer. Browser components never access Garage directly.

Report lists return presentation-only `reportUrl` values. PM Agent renders those values as Markdown links. Persisted metadata and save/view payloads do not gain presentation fields.

Existing unmerged development objects stored under old global keys are not migrated. No shipped compatibility requirement exists.

## Data Flow

Generic agent object operation:

1. Agent invokes a Garage MCP tool with a relative key.
2. Tool reads trusted `context.agent.agentId`.
3. Namespace helper produces the physical Garage key.
4. Shared adapter performs the object operation.
5. Tool returns relative keys or text content.

PM report operation:

1. PM Agent invokes a PM-specific tool.
2. Tool binds storage to the fixed `pm-agent` namespace.
3. PM repository reads or writes typed report objects.
4. Server-only client modules bind to the same namespace for report pages.
5. Chat displays tool-provided relative report URLs through existing Markdown rendering.

## Failure Behavior

- Missing agent identity: reject before storage access.
- Invalid key or oversized text: return a validation error.
- Create collision: report that the key already exists.
- Missing get, replace, or delete target: report that the object was not found.
- Approval rejected: perform no mutation.
- Garage unavailable or misconfigured: return an actionable configuration or connectivity error without secrets.
- PM report save failure: PM Agent still returns its analysis and adds a short save-failure message.

## Testing

Generic branch tests cover:

- key canonicalization and traversal rejection;
- agent namespace isolation;
- missing execution identity;
- create collision behavior;
- get and bounded list behavior;
- approved replace and delete behavior;
- storage existence and deletion contracts;
- MCP tool list, annotations, execution, and stored-agent hydration;
- Compose and development launcher structure;
- full `npm run check`, `npm run build`, and `git diff --check`.

PM branch tests cover:

- PM report persistence and namespace binding;
- metadata parsing and report ownership;
- save/list/view tools;
- API validation and safe errors;
- report list and detail pages;
- Markdown report links and Garage MCP separation;
- full `npm run check`, `npm run build`, and `git diff --check`.

## GitHub Transition

After both replacement branches are implemented, reviewed, and locally verified:

1. Implement, verify, and commit the generic Garage branch locally.
2. Ask for approval to push it and open its pull request.
3. Implement, verify, and commit the PM branch locally.
4. Ask separately for approval to push it and open its stacked pull request.
5. Merge generic branch only after CI passes and user approves.
6. Rebase and retarget PM branch only after user approves.
7. Close old PRs #1 and #2 only after replacement PRs pass CI and user approves.
8. Delete old remote branches only after explicit final confirmation.

No force-push, branch deletion, pull-request closure, or worktree cleanup is implicit.
