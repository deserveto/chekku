# UI/UX Auth, Reports, Sidebar, and Agent Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a cohesive Chekku UI refresh covering premium split auth screens, report navigation/detail hierarchy, ChatGPT-style sidebar controls, an account menu, and persistent selectable agent icons.

**Architecture:** Keep Better Auth, report storage, thread ownership, and Mastra APIs unchanged. Add small reusable presentation components (`AuthLayout`, `AgentIcon`, `ReportTabs`), persist stored-agent icon IDs in Mastra's supported `metadata.uiIcon`, and express the visual system through the existing `studio.css` tokens.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, CSS, Vitest, Better Auth, Mastra stored-agent APIs, statically imported PNG assets.

## Global Constraints

- Work on branch `codex/ui-ux-auth-reports-sidebar-agent-icons`.
- Preserve Chekku's warm charcoal, parchment, and muted-sage design system.
- Preserve all server-only report boundaries and Better Auth behavior.
- Use test-first red/green cycles for behavior changes.
- Run `npm run check` and `npm run build` before completion.

---

### Task 1: Premium auth composition

**Files:**
- Create: `client/src/components/auth/auth-layout.tsx`
- Add: `client/src/assets/auth/login-low-poly.png`
- Add: `client/src/assets/auth/signup-low-poly.png`
- Modify: `client/src/app/login/page.tsx`
- Modify: `client/src/app/signup/page.tsx`
- Modify: `client/src/app/studio.css`
- Test: `client/src/app/auth-pages.test.ts`

**Interfaces:**
- Consumes: existing `BrandMark`, Better Auth submit handlers, generated static images.
- Produces: `AuthLayout({ image, imageAlt, eyebrow, title, description, quote, children })`.

- [ ] **Step 1: Write failing auth structure tests**

Assert that login and signup use `AuthLayout`, import distinct assets, expose useful image alt text, and retain their current form fields and cross-links.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run client/src/app/auth-pages.test.ts`

- [ ] **Step 3: Implement the shared split layout and responsive styles**

Use `next/image`, semantic `aside`/`section`, a tall editorial visual panel on desktop, a compact atmospheric banner on tablet, and a single-column form on mobile. Preserve error, pending, autocomplete, verification, and redirect behavior.

- [ ] **Step 4: Run the focused test and confirm pass**

Run: `npx vitest run client/src/app/auth-pages.test.ts`

### Task 2: Sidebar collapse and account menu

**Files:**
- Modify: `client/src/components/studio/studio-nav.tsx`
- Modify: `client/src/components/chat/chat-studio.tsx`
- Modify: `client/src/app/studio.css`
- Create: `client/src/app/settings/page.tsx`
- Test: `client/src/components/studio/studio-nav.test.ts`
- Test: `client/src/lib/ui-structure.test.ts`

**Interfaces:**
- Consumes: `ResizableSidebar` collapsed state and existing Better Auth `signOut()`.
- Produces: collapsed logo-to-expand hover/focus affordance and an accessible `Account` menu with `Settings` and `Sign out`.

- [ ] **Step 1: Write failing sidebar/menu structure tests**

Assert menu semantics, settings link, sign-out action, collapsed overlay CSS, and matching chat/studio brand-row behavior.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run client/src/components/studio/studio-nav.test.ts client/src/lib/ui-structure.test.ts`

- [ ] **Step 3: Implement the interaction and settings destination**

Use a profile trigger, upward popover, Escape/outside-click close behavior, and a collapsed avatar-only trigger. Overlay the expand button on the logo only while the collapsed brand row is hovered or focus-within.

- [ ] **Step 4: Run focused tests and confirm pass**

Run: `npx vitest run client/src/components/studio/studio-nav.test.ts client/src/lib/ui-structure.test.ts`

### Task 3: Persistent agent icon system

**Files:**
- Create: `client/src/components/agents/agent-icon.tsx`
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/server/agent-payload.ts`
- Modify: `client/src/lib/stored-agents.ts`
- Modify: `client/src/components/agents/agent-catalog-page.tsx`
- Modify: `client/src/components/agents/agent-builder-page.tsx`
- Modify: `client/src/app/studio.css`
- Test: `client/src/server/agent-payload.test.ts`
- Test: `client/src/lib/stored-agents.test.ts`
- Test: `client/src/lib/ui-structure.test.ts`

**Interfaces:**
- Produces: `AgentIconId`, `AGENT_ICON_IDS`, `defaultAgentIcon(id)`, `readAgentIcon(metadata, id)`, and `<AgentIcon icon={...} />`.
- Persists: `{ metadata: { uiIcon: iconId } }` for stored agents.

- [ ] **Step 1: Write failing metadata and rendering tests**

Cover supported icon validation, safe fallback for missing/unknown metadata, payload persistence, migration preservation, distinct built-in mappings, and selector presence.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run client/src/server/agent-payload.test.ts client/src/lib/stored-agents.test.ts client/src/lib/ui-structure.test.ts`

- [ ] **Step 3: Implement icons, metadata flow, and selector**

Use a small local SVG set with consistent stroke weight. Render dedicated built-in icons and persist only allowlisted icon IDs for stored agents.

- [ ] **Step 4: Run focused tests and confirm pass**

Run: `npx vitest run client/src/server/agent-payload.test.ts client/src/lib/stored-agents.test.ts client/src/lib/ui-structure.test.ts`

### Task 4: Cohesive reports experience

**Files:**
- Create: `client/src/components/reports/report-tabs.tsx`
- Modify: `client/src/app/reports/page.tsx`
- Modify: `client/src/app/reports/weekly/page.tsx`
- Modify: `client/src/app/reports/competitive/page.tsx`
- Modify: `client/src/app/reports/[reportId]/page.tsx`
- Modify: `client/src/app/reports/competitive/[analysisId]/page.tsx`
- Modify: `client/src/app/studio.css`
- Test: `client/src/app/reports/reports-pages.test.ts`
- Test: `client/src/app/reports/competitive/competitive-pages.test.ts`

**Interfaces:**
- Produces: `ReportTabs({ active: 'all' | 'weekly' | 'competitive' })` with stable report routes.

- [ ] **Step 1: Write failing report navigation/hierarchy tests**

Assert shared tabs on landing/lists, human-readable detail titles, prominent analysis typography, and visually secondary metadata/source sections while preserving route, safety, and Markdown invariants.

- [ ] **Step 2: Run focused report tests and confirm failure**

Run: `npx vitest run client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts`

- [ ] **Step 3: Implement tabs and editorial report hierarchy**

Align report headers and detail content to one max width, keep analysis primary, style metadata as technical context, and retain all slides/share controls and server-side fetch boundaries.

- [ ] **Step 4: Run focused report tests and confirm pass**

Run: `npx vitest run client/src/app/reports/reports-pages.test.ts client/src/app/reports/competitive/competitive-pages.test.ts`

### Task 5: Visual QA and repository verification

**Files:**
- Modify only files required by confirmed visual or test regressions.

- [ ] **Step 1: Run client typecheck and lint**

Run: `npm run typecheck --workspace client && npm run lint --workspace client`

- [ ] **Step 2: Inspect auth, reports, sidebar, and icon selector at desktop/mobile widths**

Use the running Next.js app if available; capture and inspect representative screenshots and check keyboard focus, hover, menu positioning, overflow, and image crops.

- [ ] **Step 3: Run full required verification**

Run: `npm run check`

- [ ] **Step 4: Run production build**

Run: `npm run build`

- [ ] **Step 5: Request ultra-mode caveman diff review and fix all important findings**

Review against this plan, architecture invariants, accessibility, persistence, and responsive behavior.
