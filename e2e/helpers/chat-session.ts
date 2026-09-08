import { expect, type Page } from '@playwright/test';
import { deleteTestUser, markEmailVerified } from './auth-db';

const QA_PASSWORD = 'e2e-TestPass-42';

/** Retries allowed per auth POST once the 5-per-60s cap has been hit. */
const RATE_LIMIT_RETRIES = 2;
/** Ceiling on one retry-after wait so a bad header cannot stall the run. */
const MAX_RETRY_WAIT_MS = 90_000;

/**
 * Submits an auth form, honouring the server's own `retry-after` when the
 * in-process limiter rejects the POST.
 *
 * A full `npm run test:e2e` makes more signup/sign-in POSTs than the
 * 5-per-60-seconds-per-scope cap allows — every spec that needs a session
 * creates its own account, and without `RATE_LIMIT_TRUST_PROXY` they all share
 * one bucket. The 429 body is plain text, so Better Auth's client surfaces no
 * message and the page shows the generic "Sign-in failed." while staying on
 * /login, which reads as an unrelated failure. Backing off is what a real
 * client would do, and keeps the suite honest about the production limit
 * instead of weakening it.
 */
async function submitAuthForm(
  page: Page,
  args: { buttonName: string; endpoint: string },
): Promise<void> {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(args.endpoint) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: args.buttonName }).click();
    const response = await responsePromise;
    if (response.status() !== 429) return;

    const retryAfterSeconds = Number(response.headers()['retry-after']);
    const waitMs = Math.min(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? (retryAfterSeconds + 1) * 1000
        : 61_000,
      MAX_RETRY_WAIT_MS,
    );
    console.warn(
      '[e2e] %s rate limited; waiting %ds before retry %d/%d',
      args.endpoint,
      Math.round(waitMs / 1000),
      attempt + 1,
      RATE_LIMIT_RETRIES,
    );
    await page.waitForTimeout(waitMs);
  }

  throw new Error(
    `${args.endpoint} stayed rate limited after ${RATE_LIMIT_RETRIES} retries.`,
  );
}

/**
 * Creates a fresh verified account through the real signup UI, verifies it
 * via the auth database seam, signs back in, and returns the email so the
 * caller can clean the user up in afterAll.
 */
export async function createVerifiedChatSession(
  page: Page,
  label: string,
): Promise<string> {
  const email = `e2e-chat-${label}-${Date.now().toString(36)}@chekku.test`;

  await page.goto('/signup');
  await page.getByLabel('Name').fill('E2E Chat Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(QA_PASSWORD);
  await page.getByLabel('Confirm password').fill(QA_PASSWORD);
  await submitAuthForm(page, {
    buttonName: 'Create account',
    endpoint: '/api/auth/sign-up/email',
  });
  await expect(page.getByText('Check your email.')).toBeVisible();

  await markEmailVerified(email);

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(QA_PASSWORD);
  await submitAuthForm(page, {
    buttonName: 'Sign in',
    endpoint: '/api/auth/sign-in/email',
  });
  await expect(page).toHaveURL(/\/agents$/);

  return email;
}

export async function deleteChatSessionUser(email: string): Promise<void> {
  await deleteTestUser(email).catch((error: unknown) => {
    console.warn(
      '[e2e] chat test-user cleanup failed (%s); the next run sweeps stale rows',
      error instanceof Error ? error.name : 'unknown',
    );
  });
}

/**
 * Opens a fresh main-agent conversation and waits until the studio is ready
 * to accept a message (the model readiness gate re-enables the composer).
 */
export async function openMainAgentChat(page: Page): Promise<void> {
  await page.goto('/chat?agent=main-agent');
  await expect(
    page.locator('.chat-composer textarea'),
  ).toBeVisible({ timeout: 30_000 });
}

/** Fills the composer and clicks send; callers wait for terminal state
 * themselves (usually by polling the sidebar's running indicator). */
export async function sendChatTurn(page: Page, prompt: string): Promise<void> {
  await page.locator('.chat-composer textarea').fill(prompt);
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
}

export { QA_PASSWORD };
