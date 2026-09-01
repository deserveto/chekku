import { expect, test } from '@playwright/test';

test.describe('auth gate (middleware redirects and public login page)', () => {
  test('redirects unauthenticated visits to /agents back to /login', async ({
    page,
  }) => {
    await page.goto('/agents');

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole('button', { name: 'Sign in' }),
    ).toBeVisible();
  });

  test('renders the sign-in form with a signup link', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    const signupLink = page.getByRole('link', { name: 'Create one' });
    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveAttribute('href', '/signup');
  });

  test('shows the success banner after the email verification redirect', async ({
    page,
  }) => {
    await page.goto('/login?verified=1');

    await expect(page.getByRole('status')).toContainText(
      'Your email has been verified',
    );
  });

  test('shows the error banner for an invalid verification redirect', async ({
    page,
  }) => {
    await page.goto('/login?verified=1&error=invalid_token');

    await expect(page.getByRole('alert')).toContainText(
      'invalid or has expired',
    );
    await expect(
      page.getByRole('link', { name: 'Resend verification email' }),
    ).toHaveAttribute('href', '/verify-email');
  });

  test('returns 403 JSON for unauthenticated API requests instead of redirecting', async ({
    request,
  }) => {
    const response = await request.get('/api/storage/social-posts');

    expect(response.status()).toBe(403);
    expect(response.headers()['content-type'] ?? '').toContain(
      'application/json',
    );
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe('forbidden');
  });

  test('shows the verified confirmation panel on /verify-email', async ({
    page,
  }) => {
    await page.goto('/verify-email?status=verified');

    await expect(page.getByText('Email confirmed.')).toBeVisible();
    await expect(page.getByText('Verification complete')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Sign in', exact: true }),
    ).toHaveAttribute('href', '/login');
  });

  test('reset-password without a token reports an invalid link', async ({
    page,
  }) => {
    await page.goto('/reset-password');

    await expect(page.getByText('Reset link problem')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      'invalid or has expired',
    );
    await expect(
      page.getByRole('link', { name: 'Request a new link' }),
    ).toHaveAttribute('href', '/forgot-password');

    await page.goto('/reset-password?token=x&error=1');
    await expect(page.getByText('Reset link problem')).toBeVisible();
  });
});
