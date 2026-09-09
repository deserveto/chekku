# Agent Page E2E Result

## Run

- Date: 2026-09-07
- Target: `https://app.chekku.rafiqspace.ai/agents`
- Browser: Chromium
- Result: **PASS**
- Tests: 1 passed, 0 failed
- Duration: 4.2 seconds

Command used credentials through environment variables only; no credential values are stored in this repository:

```text
CHEKKU_E2E_BASE_URL=https://app.chekku.rafiqspace.ai
CHEKKU_E2E_AGENT_CATALOG=1
CHEKKU_E2E_EMAIL=<redacted>
CHEKKU_E2E_PASSWORD=<redacted>
npm run test:e2e -- e2e/agent-catalog.spec.ts --project=chromium
```

## Coverage

- Authenticated sign-in redirects to `/agents`.
- Agent catalog heading and registry controls render.
- All, Built-in, and Custom source tabs expose correct selection state.
- Search finds `main-agent`.
- Search clear control restores the catalog.
- Custom filter shows the empty state when no custom agents exist.
- Clear filters restores All.
- New agent link points to `/agents/new`.

## Observed production state

- 5 built-in agents listed.
- 0 custom agents listed.
- The authenticated session was created or refreshed for the test; no account profile, agent, or thread data was created or modified.
