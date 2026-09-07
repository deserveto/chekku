import { expect, test } from '@playwright/test';
import {
  createVerifiedChatSession,
  deleteChatSessionUser,
  openMainAgentChat,
  sendChatTurn,
} from './helpers/chat-session';

/**
 * E2E for the Knowledge chip reconciliation: a chat-uploaded file shows a
 * minimalist indexing chip, flips to "Added to Knowledge" once the
 * server-side ingestion finishes (the client polls the authenticated list
 * endpoint), and the document lands on /knowledge as a ready card.
 */
test.describe('knowledge chip reconciliation', () => {
  test.describe.configure({ mode: 'serial' });

  let testEmail: string;

  test.afterAll(async () => {
    await deleteChatSessionUser(testEmail);
  });

  test('surfaces indexing, completion, and the knowledge card', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    testEmail = await createVerifiedChatSession(page, 'kb');
    await openMainAgentChat(page);

    await page.getByRole('button', { name: 'Attach files' }).click();
    await page.setInputFiles('input[type="file"]', {
      name: 'chekku-e2e-kb.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Chekku e2e knowledge probe. The zephyr hummingbird writes quarterly reports in Basque.',
        'utf8',
      ),
    });
    await expect(page.getByText('chekku-e2e-kb.txt')).toBeVisible();

    await sendChatTurn(page, 'What file did I attach? Answer in one sentence.');

    const chip = page.locator('.chat-knowledge-status').first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Indexing');

    // The chip must REACH a terminal state, not stay "indexing" forever.
    await expect(chip).toContainText('Added to Knowledge', {
      timeout: 120_000,
    });

    // The same document appears on /knowledge as a ready card.
    await page.goto('/knowledge');
    const card = page
      .locator('article.studio-report-card')
      .filter({ hasText: 'chekku-e2e-kb.txt' });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(
      card.locator('[data-knowledge-status="ready"]'),
    ).toBeVisible();
  });
});
