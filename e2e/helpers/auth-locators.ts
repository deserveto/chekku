import type { Locator, Page } from '@playwright/test';

export function authAlert(page: Page, text: string | RegExp): Locator {
  return page.getByRole('alert').filter({ hasText: text });
}
