# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The internal team of PT Rafiq Space Intelligence, self-hosting Chekku on a personal machine or private server. Primary job: a daily agent workbench — running QA passes over web apps and Android builds, producing weekly-report and competitive-analysis documents, drafting and approving social media content, and chatting with general-purpose agents. Secondary job: building and editing stored agents through the visual builder. Design optimizes for operator endurance across long working sessions, not first-visit marketing.

## Product Purpose

Chekku is a local-first agent studio for building, running, and testing Mastra agents. It gives one registry over code-defined agents (main assistant, QA Web, QA Android, PM, Social Media Writer/Supervisor/Strategist, Visual Content) and user-created stored agents, with agent-isolated chat history, multimodal file uploads, slash-command skills, Garage-backed report and social-post archives, and scheduled workflows (weekly social drafts, Monday 09:00 Asia/Jakarta). Success means the team runs its whole agent workload — QA, research, content — without leaving the studio and without any cloud dependency.

## Positioning

Local-first and server-owned: the Mastra runtime, Postgres memory, Garage object storage, SearXNG search, and the self-hosted Reader all run on the operator's own machine; browser traffic passes through a same-origin proxy so credentials never reach the client. A neighboring SaaS agent builder cannot truthfully copy "your keys, your data, your machine" combined with server-owned run lifecycles (runs survive tab closes, enforce one-run-per-thread, replay from offset) and fixed, bounded built-in capabilities instead of arbitrary tool installation.

## Operating Context

- Runs via `npm run dev:sh` (host processes + Docker services: Garage, SearXNG, Reader, Postgres) or fully containerized via `npm run prod:sh` behind a reverse proxy.
- Authenticated with Better Auth email/password; every thread, report, and social post is scoped to the signed-in user.
- The Social Media Content Writer is additionally reachable over Telegram; social posts move through a DRAFT → CANONICAL_APPROVED → APPROVED → PUBLISHED approval pipeline in `/social-posts`.
- Competitive-analysis decks are shareable via token-gated public URLs (`/public/slides/<id>?t=`) for recipients without accounts.
- Operators are technical (comfortable with env vars, Docker, and reading logs); Indonesian and English both appear in operational content (social drafts are Indonesian-first; UI copy is English).

## Capabilities and Constraints

- Surfaces: studio home, agent catalog + stored-agent builder (`/agents`), per-agent chat with thread history and multimodal uploads (`/chat`), PM report viewers (`/reports`, weekly + competitive + slide decks), social-post pipeline (`/social-posts`), settings, auth pages (login, signup, verify-email, forgot/reset-password), token-gated public slides.
- Eight code-defined agents plus user-created stored agents (`@mastra/editor`); code-defined agents are protected from edit/delete through stored-agent APIs.
- Three supervisor sub-agents (Content Writer, Strategist, Visual Content) are hidden from the UI catalog but remain reachable as delegation targets.
- Uploads: text files, images, PDFs (rendered to page images client-side); caps are enforced server-side (8 attachments, 8 MiB base64 per message, 12 MiB body limit).
- Fixed built-in MCP capabilities only (Garage objects, SearXNG search, Web Reader) — no arbitrary MCP URLs, commands, or tool overrides.
- Known deferred fact: per-user stored-agent ownership is not yet implemented (stored agents are global).
- Constraint that outlives any redesign: no browser-exposed secrets; model keys stay server-side; system/self-hosted font stacks only (no runtime font downloads from Google).

## Brand Commitments

- The product brand is **Chekku** (name + `docs/chekku-logo.svg`). Confirmed binding: UI branding is Chekku-only.
- **Rafiqspace** is a configured LLM gateway label and a content-side brand (generated social visuals, Instagram identity "R — Your Gentle AI Companion") — it must NOT appear in the studio interface.
- The incumbent visual world ("The Warm Workshop") is recorded in `DESIGN.md` and is the authority for visual decisions.

## Evidence on Hand

- `docs/chekku-logo.svg` — the product logo.
- Real, working surfaces for every route listed above (not mockups); agent catalog, chat, reports, and social-posts flows are in daily internal use.
- No marketing site, testimonials, customer logos, or benchmark claims exist — none may be fabricated; the product has no public-facing marketing surface.

## Product Principles

1. **Operator endurance over spectacle.** A daily workbench: scanability, compact density, quiet motion; personality lives in precise details, not decoration.
2. **Local-first sovereignty.** Credentials, memory, and artifacts stay on the operator's machine; the UI never needs to know a secret.
3. **Agent isolation is sacred.** Threads, reports, and posts belong to exactly one agent and one user; history never leaks across boundaries.
4. **Bounded and fail-closed.** Every capability (uploads, search, reading, image generation) carries explicit caps and fixed actionable errors; unconfigured features fail closed, never silently.
5. **Server-owned truth.** Runs, thread titles, and state live on the server; the browser is a window, not the source of record.

## Accessibility & Inclusion

- Keyboard operability and visible `:focus-visible` rings on every interactive element are established in the incumbent implementation and must be preserved.
- Text contrast meets AA on the dark warm theme (verified for the muted text tone); new surfaces must not regress this.
- `prefers-reduced-motion` reductions exist (card lifts, shimmer) and new motion must honor them.
- Chat tables are horizontally scrollable, keyboard-focusable, and labeled as regions.
