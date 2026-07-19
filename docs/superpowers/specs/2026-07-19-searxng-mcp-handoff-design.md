# SearXNG MCP Handoff Prompt Design

## Goal

Produce one self-contained prompt that a new coding session can use to design and implement a built-in SearXNG MCP capability in Chekku without losing current repository context or architecture constraints.

## Prompt Scope

The handoff prompt must tell the new session to:

1. inspect Git state, `AGENTS.md`, current architecture, and Garage MCP implementation before changing files;
2. use brainstorming before implementation to clarify local Docker versus external SearXNG deployment, fixed tool registry, result limits, URL-reading scope, approvals, and error boundaries;
3. consult current official SearXNG/Mastra documentation rather than assuming APIs;
4. write and approve a design spec and implementation plan;
5. implement end-to-end with regression tests, documentation, full checks, and build;
6. request permission before push, PR creation, branch deletion, or history rewriting.

## Architecture Context

The prompt must preserve these facts:

- `agent/src/mastra/index.ts` is the single Mastra composition root.
- Garage is a fixed built-in MCP server registered as `mcpServers: { garage: garageMcpServer }`.
- Garage exposes exactly five generic tools and must remain unchanged.
- Stored-agent Garage selection persists `{ garage: { tools: {} } }`.
- The client proxy rejects arbitrary MCP URLs, commands, packages, environment values, and credentials.
- Current proxy validation is Garage-specific and currently permits exactly one MCP key; SearXNG support requires a safe fixed-registry/subset design rather than weakening validation.
- PM report tools remain code-defined and separate from generic MCP servers.
- Main, QA Web, Social Media, and PM agents plus model, Memory, identity, approval, proxy, and report boundaries must remain intact.

## Git Context

At prompt-generation time, local `main` is ahead of `origin/main` by weekly-report planning commits. The final inline prompt must tell the next session to run fresh Git checks and preserve all local commits and changes. It must not treat recorded commit counts as authoritative after session transition.

## Output

Return one fenced Markdown prompt ready to paste into a new session. The prompt should be direct, detailed, and action-oriented. It must not prescribe an unapproved SearXNG tool list or deployment model.
