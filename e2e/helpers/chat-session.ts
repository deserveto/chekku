import { expect, type Page } from '@playwright/test';
import { deleteTestUser, markEmailVerified } from './auth-db';

const QA_PASSWORD = 'e2e-TestPass-42';

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
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email.')).toBeVisible();

  await markEmailVerified(email);

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(QA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
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
