import { expect, test, type Page } from '@playwright/test';
import {
  closeAuthDb,
  deleteTestUser,
  markEmailVerified,
} from '../helpers/auth-db';

const runStamp = `${Date.now().toString(36)}-${process.pid ?? 0}`;
const testEmail = `e2e-auth-${runStamp}@chekku.test`;
const unknownEmail = `e2e-missing-${runStamp}@chekku.test`;
const testPassword = 'e2e-TestPass-42';
const testUserName = 'E2E Auth Tester';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await deleteTestUser(testEmail).catch(() => undefined);
  await closeAuthDb();
});

async function fillSignupForm(
  page: Page,
  args: { email: string; password: string; confirmPassword: string },
): Promise<void> {
  await page.getByLabel('Name').fill(testUserName);
  await page.getByLabel('Email').fill(args.email);
  await page.getByLabel('Password', { exact: true }).fill(args.password);
  await page.getByLabel('Confirm password').fill(args.confirmPassword);
}

async function submitSignIn(
  page: Page,
  args: { email: string; password: string },
): Promise<void> {
  await page.getByLabel('Email').fill(args.email);
  await page.getByLabel('Password', { exact: true }).fill(args.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('auth flow (signup -> verify -> sign-in -> sign-out)', () => {
  test('rejects mismatched signup passwords without calling the API', async ({
    page,
  }) => {
    await page.goto('/signup');
    await fillSignupForm(page, {
      email: testEmail,
      password: testPassword,
      confirmPassword: 'different-password',
    });
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('alert')).toContainText(
      'Passwords do not match.',
    );
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('signs up a new account and shows the verification notice', async ({
    page,
  }) => {
    await page.goto('/signup');
    await fillSignupForm(page, {
      email: testEmail,
      password: testPassword,
      confirmPassword: testPassword,
    });
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Check your email.')).toBeVisible();
    await expect(page.getByText('Verification email sent')).toBeVisible();
    await expect(page.getByText(testEmail).first()).toBeVisible();
  });

  test('rejects signup with an already registered email', async ({ page }) => {
    await page.goto('/signup');
    await fillSignupForm(page, {
      email: testEmail,
      password: testPassword,
      confirmPassword: testPassword,
    });
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('alert')).toContainText(/already exist/i);
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('rejects sign-in with a wrong password', async ({ page }) => {
    await page.goto('/login');
    await submitSignIn(page, { email: testEmail, password: 'wrong-password' });

    await expect(page.getByRole('alert')).toContainText(
      'Invalid email or password',
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test('blocks sign-in until the email is verified', async ({ page }) => {
    await page.goto('/login');
    await submitSignIn(page, { email: testEmail, password: testPassword });

    await expect(page.getByRole('alert')).toContainText(/verif/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('resends the verification email for a registered address', async ({
    page,
  }) => {
    await page.goto('/verify-email');
    await page.getByLabel('Resend to').fill(testEmail);
    await page.getByRole('button', { name: 'Resend verification' }).click();

    await expect(page.getByRole('status')).toContainText(
      'If that account exists',
    );
  });

  test('signs in a verified account, guards auth pages, and signs out', async ({
    page,
  }) => {
    await markEmailVerified(testEmail);

    await page.goto('/login');
    await submitSignIn(page, { email: testEmail, password: testPassword });

    await expect(page).toHaveURL(/\/agents$/);
    const cookies = await page.context().cookies();
    expect(
      cookies.some((cookie) =>
        cookie.name.startsWith('better-auth.session_token'),
      ),
    ).toBe(true);

    await expect(
      page.getByRole('button', { name: 'Account menu' }),
    ).toBeVisible({ timeout: 20_000 });
    await page.goto('/login');
    await expect(page).toHaveURL(/\/agents$/);

    await page.reload();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(
      page.getByRole('button', { name: 'Account menu' }),
    ).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/agents');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('reset link form', () => {
  test('rejects a reset attempt with an invalid token', async ({ page }) => {
    await page.goto('/reset-password?token=e2e-invalid-token');
    await page.getByLabel('New password').fill('e2e-ResetPass-42');
    await page.getByLabel('Confirm password').fill('e2e-ResetPass-42');
    await page.getByRole('button', { name: 'Reset password' }).click();

    await expect(page.getByRole('alert')).toContainText(
      'invalid or has expired',
    );
  });
});

test.describe('forgot password', () => {
  test('confirms a reset request for a registered email', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(testEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByText('Reset link requested')).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      'If that account exists',
    );
  });

  test('shows the same neutral confirmation for an unknown email', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(unknownEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByText('Reset link requested')).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      'If that account exists',
    );
  });
});
