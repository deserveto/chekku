import { expect, test, type Page } from '@playwright/test';
import {
  closeAuthDb,
  deleteTestUser,
  markEmailVerified,
  sweepStaleTestUsers,
} from '../helpers/auth-db';

const runStamp = `${Date.now().toString(36)}-${process.pid ?? 0}`;
const testEmail = `e2e-agent-probe-${runStamp}@chekku.test`;
const testPassword = 'e2e-TestPass-42';
const testUserName = 'E2E Agent Probe';

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
  test.setTimeout(120_000);
  // Remove users left behind by an interrupted previous run.
  await sweepStaleTestUsers();

  const context = await browser.newContext();
  page = await context.newPage();

  await page.goto('/signup');
  await page.getByLabel('Name').fill(testUserName);
  await page.getByLabel('Email').fill(testEmail);
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByLabel('Confirm password').fill(testPassword);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email.')).toBeVisible();

  // Local dev cannot complete a real mailbox round trip.
  await markEmailVerified(testEmail);

  await page.goto('/login');
  await page.getByLabel('Email').fill(testEmail);
  await page.getByLabel('Password', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/agents$/);
});

test.afterAll(async () => {
  await page?.context().close().catch(() => {});
  await deleteTestUser(testEmail).catch((error: unknown) => {
    console.warn(
      '[e2e] agent-probe test-user cleanup failed (%s); the next run sweeps stale rows',
      error instanceof Error ? error.name : 'unknown',
    );
  });
  await closeAuthDb();
});

/**
 * Read the agent ids the studio catalog actually offers. This is the same list
 * a user sees, so built-ins and stored agents are both covered and a newly
 * created agent is picked up without touching this spec.
 */
async function discoverCatalogAgentIds(): Promise<string[]> {
  await page.goto('/agents');
  const cards = page.locator('article.studio-agent-card');
  await expect(
    cards.first(),
    'the agent catalog never rendered a card — is the agent server running?',
  ).toBeVisible({ timeout: CATALOG_TIMEOUT_MS });
  await expect(page.locator('.studio-alert-error')).toHaveCount(0);

  const ids = (
    await cards.locator('.studio-agent-card-body code').allInnerTexts()
  )
    .map((value) => value.trim())
    .filter(Boolean);

  expect(ids.length, 'the agent catalog listed no agents').toBeGreaterThan(0);
  return ids;
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

test('every agent in the studio catalog answers the capability probe without crashing', async () => {
  const agentIds = await discoverCatalogAgentIds();
  // Budget scales with what the catalog actually holds.
  test.setTimeout(CATALOG_TIMEOUT_MS + agentIds.length * PER_AGENT_BUDGET_MS);
  console.log('[e2e] probing %d catalog agents: %s', agentIds.length, agentIds.join(', '));

  const failures: string[] = [];
  for (const agentId of agentIds) {
    // Catching outside the step keeps it red in the report while letting the
    // remaining agents run — one broken agent must not hide the others.
    await test
      .step(`probe agent "${agentId}"`, () => probeAgent(agentId))
      .catch((error: unknown) => {
        failures.push(
          `${agentId}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
      });
  }

  expect(
    failures,
    `${failures.length} of ${agentIds.length} agents failed the probe:\n${failures.join('\n')}`,
  ).toEqual([]);
});
