# Chekku Architecture

## Overview

Chekku is an npm workspace containing a Next.js client and a Mastra agent server. The system is local-first, uses LibSQL for persistence, and connects to one server-owned OpenAI-compatible model endpoint.

```text
┌───────────────────────────────┐
│ Browser                       │
│ Agent catalog, builder, chat  │
└───────────────┬───────────────┘
                │ HTTP /api/agent/*
                ▼
┌───────────────────────────────┐
│ Next.js client :3000          │
│ Same-origin proxy + auth seam │
└───────────────┬───────────────┘
                │ Mastra HTTP API
                ▼
┌──────────────────────────────────────────┐
│ Mastra server :4111                      │
│                                          │
│  Code agents      Stored agents          │
│  - main-agent     - @mastra/editor       │
│  - qa-web-agent   - database versions    │
│                                          │
│  Memory + LibSQLStore                    │
│  Calculator + current-time tools         │
│  Agent Browser                           │
│  OpenAI-compatible custom gateway        │
└───────────────────┬──────────────────────┘
                    │ /v1/models
                    │ /v1/chat/completions
                    ▼
┌──────────────────────────────────────────┐
│ Rafiqspace LLM, LiteLLM, vLLM, or other │
│ OpenAI-compatible endpoint               │
└──────────────────────────────────────────┘
```

## Backend composition

`agent/src/mastra/index.ts` creates the single `Mastra` instance and registers:

- `mainAgent` and `qaWebAgent`;
- `storedAgentTools`;
- `LibSQLStore`;
- `MastraEditor` with database storage;
- `OpenAICompatibleGateway`;
- structured logging and request middleware;
- `/healthz` and `/models` custom routes.

All other agent, Memory, editor, and storage APIs are provided by Mastra. Chekku does not maintain a parallel custom conversation or agent database.

## Agents

### Main Agent

`main-agent` is the default general-purpose assistant. It uses the common server model and Mastra Memory. It does not claim browser capabilities.

### QA Web Agent

`qa-web-agent` adds Mastra Agent Browser to the common model and Memory stack. Memory is mandatory because browser context processors need a live Memory context during tool loops.

Interactive browser tools require approval unless the request context explicitly enables full browser access. Consequential actions still require user confirmation through the agent instructions.

### Stored agents

Stored agents are created through the client and persisted by `@mastra/editor`. A stored record contains behavior, model selection, Memory configuration, tools, and delegate-agent references. It does not contain endpoint credentials.

When an older stored model no longer matches the current registry, the client migrates it to the configured gateway and canonical default before chat begins.

## Model gateway

The model contract is provider-neutral:

```text
LLM_BASE_URL
LLM_API_KEY
LLM_DEFAULT_MODEL
LLM_DISPLAY_NAME
LLM_MODELS
```

`getServerModel()` converts the endpoint-native default model into Chekku's custom Mastra gateway ID. The custom gateway:

1. discovers models through `GET {LLM_BASE_URL}/models`;
2. falls back to `LLM_MODELS` and `LLM_DEFAULT_MODEL` when discovery is unavailable;
3. retrieves the server-only API key;
4. creates an OpenAI-compatible chat model;
5. normalizes final prompts before generation and streaming.

The internal model format is:

```text
openai-compatible/gateway/{endpoint-native-model-id}
```

Endpoint-native IDs may contain slashes and are preserved exactly.

## System-message normalization

Some hosted vLLM chat templates reject a system message that appears after user, assistant, or tool messages. Browser and Memory processors may add context late in the prompt pipeline.

`system-message-normalizer.ts` runs at the final model transport boundary. It extracts all system messages, merges their text in original order, places the merged message first, and leaves every non-system message in its original sequence.

This normalization applies to both `doGenerate` and `doStream`.

## Storage

`LibSQLStore` is the only persistence layer. It stores:

- stored-agent definitions and versions;
- Mastra Memory threads and messages;
- other Mastra-managed state.

The default URL is `file:./mastra.db`. The actual file location depends on the working directory used to launch the agent workspace.

## Conversation ownership

Every thread is owned by an agent and resource:

```text
{agentId}-{resourceId}-{uuid}
```

The client validates this prefix before listing, reading, renaming, or deleting a thread. Changing agents creates or opens a thread owned by that agent; a conversation cannot silently switch its owner.

## Client boundaries

The browser uses `@mastra/client-js` with the Next.js origin and `/api/agent` prefix. The catch-all proxy:

- resolves the server-controlled local identity;
- validates the requested path;
- forwards requests to `AGENT_URL`;
- attaches an optional service credential;
- supports GET, POST, PUT, PATCH, DELETE, and HEAD;
- streams the upstream response back to the browser.

The current identity implementation is intentionally replaceable. Future OIDC must preserve the same resource and thread-ownership checks.

## Public routes

### Next.js

- `/` redirects to `/agents`.
- `/agents` lists code-defined and stored agents.
- `/agents/new` creates a stored agent.
- `/agents/[id]/edit` edits a stored agent.
- `/chat` opens the canonical query-based chat route.
- `/chat/[threadId]` redirects legacy thread URLs to the canonical route.
- `/api/agent/[...path]` proxies Mastra HTTP requests.

### Mastra custom routes

- `/healthz` reports service status.
- `/models` reports model configuration, canonical default, and available models.

## Extension points

Add future functionality through these boundaries:

- code-defined agents in `agent/src/agents/`;
- registered stored-agent tools in `agent/src/mastra/tools/`;
- provider-neutral gateway behavior in `agent/src/mastra/gateways/`;
- server request context and future authentication seam;
- routed client components and Mastra client helpers.

Do not add a second persistence, provider, agent-registry, or conversation architecture alongside the active one.
