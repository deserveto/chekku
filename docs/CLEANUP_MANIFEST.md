# Cleanup Manifest

This repository was rebuilt from the `chekku-reconstruction-test` workspace using the active Mastra and Next.js entry points as the source of truth. The original reconstruction ZIP remains an external archive and is not committed here.

## Cleanup strategy

A subsystem was removed when it was unreachable from the active runtime, unused by current routes, replaced by a working implementation, and likely to confuse future development.

## Generated and local artifacts

| Removed | Why | Current replacement |
| --- | --- | --- |
| `.chekku-*-backup-*` | Installer rollback copies duplicated active source. | External reconstruction archive. |
| Uploaded `.git` worktree pointer | Referenced a local Windows path and was not portable. | Initialize a new repository after extraction. |
| `client/tsconfig.tsbuildinfo` | Generated compiler cache. | Recreated automatically and ignored. |
| `mastra.db*`, build output, logs, test output | Local or generated state. | Recreated locally and excluded by `.gitignore`. |
| `handoff.md`, installer patches, old ZIPs | Session-specific reconstruction artifacts. | Current README and operations documentation. |

## Retired backend runtime

| Removed | Previous responsibility | Current replacement |
| --- | --- | --- |
| `agent/src/db/` | Custom raw-SQL schema and migrations. | Mastra `LibSQLStore`. |
| `agent/src/services/` | Custom stored-agent and conversation services. | `@mastra/editor` and Mastra Memory APIs. |
| `agent/src/mastra/routes/builder.ts` | Custom stored-agent CRUD routes. | Mastra Editor native routes through `@mastra/client-js`. |
| `agent/src/mastra/routes/chat.ts` | Custom chat and approval routes. | Mastra agent streaming APIs. |
| `agent/src/mastra/routes/conversations.ts` | Custom conversation CRUD. | Mastra Memory threads. |
| `agent/src/mastra/stream-mapper.ts` | Custom stream translation. | Mastra client streaming protocol. |
| `agent/src/agents/build.ts` | Custom stored-agent construction. | Mastra Editor hydration. |
| `agent/src/agents/registry.ts` | Parallel built-in agent registry. | `mastra.listAgents()` and client merge logic. |
| `agent/src/agents/resolver.ts` | Parallel agent resolution. | Mastra runtime/editor resolution. |
| `agent/src/agents/types.ts` | Types for retired custom records. | Mastra client response types and current client types. |
| `agent/src/catalog/` | IDs for the retired runtime catalog. | `storedAgentTools` and code-defined agents. |
| `agent/src/shared/` | Error layer used only by retired routes/search code. | Boundary-specific errors in current modules. |
| Related legacy tests | Tested deleted architecture rather than the running product. | Current Mastra, editor, Memory, gateway, and client tests. |

## Retired provider and search prototypes

| Removed | Why | Current replacement |
| --- | --- | --- |
| Inline OpenRouter free-model tool in `qa-web-agent` | Coupled QA behavior to one provider. | Generic `/models` discovery in the OpenAI-compatible gateway. |
| `agent/src/tools/openrouter-free-models.ts` | Provider-specific model lookup. | `openai-compatible-discovery.ts`. |
| `agent/src/tools/web-research/` | Dormant SearXNG/fetch/SSRF prototype. | Browser QA agent for current live-web workflows. |
| `infra/searxng/` | Infrastructure used only by the removed prototype. | No search sidecar in the current product. |
| `SEARXNG_URL` | Unused environment variable. | Removed. |
| `ipaddr.js`, direct `@libsql/client`, direct `ws`, `@hono/node-ws` | Used only by deleted code or already provided transitively. | Smaller active dependency graph. |
| Provider-specific environment examples | Conflicted with the neutral gateway. | `LLM_*` environment contract only. |

## Retired client code

| Removed | Why | Current replacement |
| --- | --- | --- |
| `agent-manager.tsx`, `agent-form.tsx`, `agent-list.tsx`, `agent-delete-dialog.tsx` | Legacy modal agent manager, no longer routed. | Routed agent catalog and builder pages. |
| `agent-selector.tsx` | Unused old selector. | Agent selector inside the current chat studio. |
| `browser-panel.tsx` | Deferred, unmounted preview UI. | QA agent runs browser tasks without a live panel. |
| `features/chat/conversation-sync.ts` | Synced retired custom conversations. | Mastra Memory thread helpers. |
| `lib/conversations-api.ts` | Called retired custom routes. | `@mastra/client-js` Memory APIs. |
| Legacy conversation migration helpers and types | No longer used by the Memory-backed UI. | Agent-owned thread IDs and Memory records. |
| Legacy global UI CSS | Styled deleted modal/chat/browser components. | Current `studio.css` plus minimal global Markdown styles. |
| Unused browser WebSocket URL export | No current live browser panel consumes it. | Removed until a real WebSocket feature is implemented. |

## Workspace and dependency cleanup

| Removed or changed | Reason |
| --- | --- |
| `agent/package-lock.json`, `client/package-lock.json` | npm workspaces use one root lockfile. |
| `patch-package` and root `postinstall` | No patch files existed. |
| `test:agents` and Node test runner | All tests now use Vitest. |
| Workspace-specific README, AGENTS, and `.gitignore` files | Root documentation and ignore policy are authoritative. |
| Root scripts | Consolidated into `typecheck`, `lint`, `test`, `check`, and `build`. |
| Agent Zod version | Pinned to `3.25.76` so Mastra dev OpenAPI generation can represent optional schemas reliably. |
| CI install | Changed from `npm install` to reproducible `npm ci`. |
| Line endings | Added `.gitattributes` and `.editorconfig` to enforce UTF-8, LF, final newlines, and trimmed trailing whitespace. |

## Documentation replacement

The following historical documents were removed because they described retired architectures or session plans:

```text
docs/AGENT_CONTRACT.md
docs/DECISIONS.md
docs/MIGRATION_FROM_CHEKKU.md
docs/PRODUCT.md
docs/PROVIDER_CONTRACT.md
docs/ROADMAP.md
docs/TOOL_CONTRACT.md
docs/superpowers/
agent/README.md
client/README.md
client/AGENTS.md
client/CLAUDE.md
```

They were replaced by:

- `README.md` — repository onboarding and quick start;
- `AGENTS.md` — coding-agent and contributor invariants;
- `docs/ARCHITECTURE.md` — only the current running architecture;
- `docs/OPERATIONS.md` — environment, storage, browser, and troubleshooting guidance;
- this manifest — historical traceability without dead source.

## Preserved extension points

The cleanup intentionally retained:

- code-defined agents;
- `@mastra/editor` stored-agent CRUD and hydration;
- LibSQL storage and Mastra Memory;
- OpenAI-compatible discovery and routing;
- hosted-vLLM system-message normalization;
- calculator and current-time tools;
- QA browser integration and approval behavior;
- agent-scoped thread ownership;
- the Next.js same-origin proxy and future authentication seam;
- current route and UI tests.
