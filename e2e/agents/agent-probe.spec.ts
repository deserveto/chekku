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
/**
 * Upper bound for ONE probe, derived from the phase caps the probe itself
 * waits on — never a hand-picked number. A budget smaller than the sum of
 * the caps expires the derived suite timeout mid-loop once a few agents run
 * slow, which silently swallows the aggregated failure report at the end
 * (the test still fails, but without the per-agent summary).
 */
const PER_AGENT_BUDGET_MS =
  RUN_START_TIMEOUT_MS + // Open chat → ?agent= URL
  RUN_START_TIMEOUT_MS + // composer ready
  RUN_START_TIMEOUT_MS + // run start / fast-terminal signal
  RESPONSE_TIMEOUT_MS + // run terminal (stop button hidden)
  // Headroom for the phases without their own named cap: the per-probe
  // `page.goto('/agents')` carries Playwright's default 30s navigation
  // timeout, and the post-reply assertions run on the default 5s expect
  // timeout each — together they can legally outlast a bare-30s headroom.
  90_000;

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

  // The catalog's "Open chat" resolves the agent's MOST RECENT thread, not
  // necessarily a fresh one; this suite's fresh-user-per-run invariant is
  // what guarantees an empty thread here. Pin it: on a reused thread the
  // previous turn's assistant article would already satisfy the 'reply'
  // fast-path below and false-green the probe.
  await expect(page.locator('article.chat-message')).toHaveCount(0);

  await composer.fill(PROBE_PROMPT);
  await page.getByRole('button', { name: 'Send message' }).click();

  const stopButton = page.getByRole('button', { name: 'Stop generation' });
  const assistant = page.locator('article.chat-message.assistant').last();
  const errorAlert = page.locator('.studio-alert-error');

  // The first observable run signal picks the path — waiting strictly for
  // the stop button misdiagnoses two real cases: an instantly-failing run
  // (gateway down, 429 — the stop button never appears) burns the whole
  // budget and reports "stop generation never appeared" instead of the real
  // error, and an ultra-fast reply can retire the stop button before the
  // first visibility poll (latent flake on fast local gateways). The
  // assistant article's mere PRESENCE cannot be a signal: the composer adds
  // an optimistic empty placeholder to React state the moment a send
  // happens, but it only reaches the DOM when the run subscription begins
  // after `startRun` resolves — the same React commit that mounts the stop
  // button (between the click and that commit there are zero assistant
  // articles) — and once attached it renders only a TypingIndicator with
  // empty text until content streams. So only the stop button, reply
  // CONTENT, the error class, or the composer alert carry meaning.
  type RunSignal = 'stop' | 'alert' | 'error-reply' | 'reply';
  let runSignal: RunSignal | null = null;
  await expect
    .poll(
      async () => {
        if (await stopButton.isVisible()) {
          runSignal = 'stop';
        } else if ((await errorAlert.count()) > 0) {
          runSignal = 'alert';
        } else if (
          await assistant.evaluate((node) => node.classList.contains('error'))
        ) {
          runSignal = 'error-reply';
        } else if (
          (await assistant.locator('.chat-message-content').allInnerTexts())
            .join(' ')
            .trim().length > 0
        ) {
          runSignal = 'reply';
        }
        return runSignal !== null;
      },
      {
        timeout: RUN_START_TIMEOUT_MS,
        message: `the run for "${agentId}" never showed a start or terminal signal within ${RUN_START_TIMEOUT_MS}ms of sending — check the /api/runs proxy, the agent server, and the model gateway`,
      },
    )
    .toBe(true);

  await expect(page.locator('article.chat-message.user').last()).toContainText(
    PROBE_PROMPT,
  );

  if (runSignal === 'alert' || runSignal === 'error-reply') {
    // Surface the agent's actual failure fast, instead of letting the reply
    // assertions below rediscover it after their own retry loops.
    const detail = [
      ...(await errorAlert.allInnerTexts()),
      ...(await assistant.locator('.chat-message-content').allInnerTexts()),
    ]
      .join(' ')
      .trim();
    throw new Error(
      `the run for "${agentId}" failed immediately: ${detail || '(no error detail rendered)'}`,
    );
  }

  // The stop button is bound to runActive, so it disappearing is the terminal
  // state of the run (finished, errored, or cancelled). Skip the wait when
  // the run already reached terminal state before the stop button could be
  // observed (fast local replies).
  if (runSignal === 'stop') {
    await expect(stopButton).toBeHidden({ timeout: RESPONSE_TIMEOUT_MS });
  }

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
