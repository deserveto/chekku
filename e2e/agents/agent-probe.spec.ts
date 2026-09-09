import { expect, test, type Page } from '@playwright/test';
import { closeAuthDb, sweepStaleTestUsers } from '../helpers/auth-db';
import {
  createVerifiedChatSession,
  deleteChatSessionUser,
} from '../helpers/chat-session';

let testEmail: string;

const PROBE_PROMPT = 'Apa yang kamu bisa lakukan untuk saya?';
const CATALOG_TIMEOUT_MS = 30_000;
const RUN_START_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 150_000;
/** Per-agent budget the whole-suite timeout is derived from. */
const PER_AGENT_BUDGET_MS = 180_000;

// One shared page for the whole file: sign in once, then probe each agent the
// catalog offers. Keeps the suite under the auth rate-limit caps.
let page: Page;

test.beforeAll(async ({ browser }) => {
  // The shared helper backs off on the auth rate limiter's 429, which a full
  // suite run reaches; budget for one retry wait on top of the sign-up flow.
  test.setTimeout(240_000);
  // Remove users left behind by an interrupted previous run.
  await sweepStaleTestUsers();

  const context = await browser.newContext();
  page = await context.newPage();
  testEmail = await createVerifiedChatSession(page, 'agent-probe');
});

test.afterAll(async () => {
  await page?.context().close().catch(() => {});
  if (testEmail) await deleteChatSessionUser(testEmail);
  await closeAuthDb();
});

interface CatalogAgent {
  id: string;
  /** True for a user-created (`source: 'stored'`) agent's card. */
  isStored: boolean;
}

/**
 * Read the agent ids the studio catalog actually offers. This is the same
 * list a user sees, so a newly added built-in is picked up without touching
 * this spec. Stored (user-created) agents are reported but not probed here —
 * see the skip note where this is consumed.
 */
async function discoverCatalogAgents(): Promise<CatalogAgent[]> {
  await page.goto('/agents');
  const cards = page.locator('article.studio-agent-card');
  await expect(
    cards.first(),
    'the agent catalog never rendered a card — is the agent server running?',
  ).toBeVisible({ timeout: CATALOG_TIMEOUT_MS });
  await expect(page.locator('.studio-alert-error')).toHaveCount(0);

  const count = await cards.count();
  const agents: CatalogAgent[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const id = (
      await card.locator('.studio-agent-card-body code').innerText()
    ).trim();
    if (!id) continue;
    const isStored =
      (await card.locator('.studio-source-badge.stored').count()) > 0;
    agents.push({ id, isStored });
  }

  expect(agents.length, 'the agent catalog listed no agents').toBeGreaterThan(
    0,
  );
  return agents;
}

/** Open a fresh chat for one agent through the catalog and probe it once. */
async function probeAgent(agentId: string): Promise<void> {
  await page.goto('/agents');
  const card = page
    .locator('article.studio-agent-card')
    .filter({ has: page.locator(`.studio-agent-card-body code:text-is("${agentId}")`) });
  await expect(card).toHaveCount(1);

  // The real entry point: the catalog resolves/creates the thread and routes.
  await card.getByRole('button', { name: 'Open chat' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]agent=${agentId}(&|$)`), {
    timeout: RUN_START_TIMEOUT_MS,
  });
  await expect(page).toHaveURL(/[?&]thread=/);

  // Scoped to the composer: the sidebar's "Active agent" <select> also carries
  // the implicit combobox role.
  const composer = page.locator('form.chat-composer textarea');
  await expect(
    composer,
    `the composer never became ready for "${agentId}" — is the agent server running with a reachable model gateway (LLM_BASE_URL / LLM_API_KEY / LLM_DEFAULT_MODEL)?`,
  ).toHaveAttribute('placeholder', /^Message /, {
    timeout: RUN_START_TIMEOUT_MS,
  });

  await composer.fill(PROBE_PROMPT);
  await page.getByRole('button', { name: 'Send message' }).click();

  const stopButton = page.getByRole('button', { name: 'Stop generation' });
  await expect(stopButton).toBeVisible({ timeout: RUN_START_TIMEOUT_MS });
  await expect(page.locator('article.chat-message.user').last()).toContainText(
    PROBE_PROMPT,
  );

  // The stop button is bound to runActive, so it disappearing is the terminal
  // state of the run (finished, errored, or cancelled).
  await expect(stopButton).toBeHidden({ timeout: RESPONSE_TIMEOUT_MS });

  const assistant = page.locator('article.chat-message.assistant').last();
  await expect(assistant).toBeVisible();
  await expect(assistant).not.toHaveClass(/\berror\b/);
  await expect(page.locator('.studio-alert-error')).toHaveCount(0);

  const replyText = (
    await assistant.locator('.chat-message-content').allInnerTexts()
  )
    .join(' ')
    .trim();
  expect(
    replyText.length,
    `assistant reply for "${agentId}" was empty`,
  ).toBeGreaterThan(0);

  await expect(page.getByText('Assistant is idle')).toBeVisible();
}

test('every built-in agent in the studio catalog answers the capability probe without crashing', async () => {
  // Provisional upper bound so the ambient default test timeout (30s) never
  // races the catalog-render expect inside discoverCatalogAgents (also 30s):
  // that expect only starts counting after `goto('/agents')` has already
  // spent part of the ambient budget, so without this the ambient timeout
  // always fires first and swallows the "is the agent server running?"
  // diagnostic. Refined below once the real agent count is known.
  test.setTimeout(CATALOG_TIMEOUT_MS * 2);

  const agents = await discoverCatalogAgents();
  const builtIn = agents.filter((agent) => !agent.isStored);
  const stored = agents.filter((agent) => agent.isStored);

  // Budget scales with what the catalog actually holds.
  test.setTimeout(CATALOG_TIMEOUT_MS + builtIn.length * PER_AGENT_BUDGET_MS);
  console.log(
    '[e2e] probing %d built-in catalog agent(s): %s',
    builtIn.length,
    builtIn.map((agent) => agent.id).join(', '),
  );
  if (stored.length > 0) {
    // Stored agents are user-created and deliberately skipped: opening their
    // chat can call ensureStoredAgentUsesServerGateway, which writes a real
    // model-gateway migration to the shared stored-agent record, and their
    // configured tools (e.g. Garage MCP) could execute real side effects in
    // response to the probe prompt. A half-configured custom agent must also
    // not fail regression coverage of the built-ins this suite exists to
    // protect. Probe a specific stored agent manually when needed.
    console.log(
      '[e2e] skipping %d stored (user-created) agent(s), not probed: %s',
      stored.length,
      stored.map((agent) => agent.id).join(', '),
    );
  }

  const failures: string[] = [];
  for (const agent of builtIn) {
    // Catching outside the step keeps it red in the report while letting the
    // remaining agents run — one broken agent must not hide the others.
    await test
      .step(`probe agent "${agent.id}"`, () => probeAgent(agent.id))
      .catch((error: unknown) => {
        failures.push(
          `${agent.id}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
      });
  }

  expect(
    failures,
    `${failures.length} of ${builtIn.length} built-in agents failed the probe:\n${failures.join('\n')}`,
  ).toEqual([]);
});
