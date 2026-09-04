import { expect, test } from '@playwright/test';
import {
  createVerifiedChatSession,
  deleteChatSessionUser,
  openMainAgentChat,
  sendChatTurn,
} from './helpers/chat-session';

/**
 * E2E for first-turn thread titles: the server generates the LLM title
 * right AFTER the run's terminal event, so ChatStudio must surface it
 * through its bounded backoff refresh WITHOUT a manual page reload.
 */
test.describe('first-turn thread title', () => {
  test.describe.configure({ mode: 'serial' });

  let testEmail: string;

  test.afterAll(async () => {
    await deleteChatSessionUser(testEmail);
  });

  test('updates the sidebar title without a reload after the first turn', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    testEmail = await createVerifiedChatSession(page, 'title');
    await openMainAgentChat(page);

    await sendChatTurn(
      page,
      'Reply with exactly: title probe acknowledged. Nothing else.',
    );

    const history = page.getByRole('navigation', {
      name: 'Conversation history',
    });
    const activeRow = history.locator('.chat-thread-row.active');
    await expect(activeRow).toBeVisible({ timeout: 30_000 });
    await expect(activeRow.locator('strong')).toHaveText('New conversation');

    // The run finishes first ("Running" indicator disappears), then the
    // title LLM call lands; the client retry chain must pick it up live.
    await expect
      .poll(
        async () => history.locator('.chat-thread-status').count(),
        { timeout: 180_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toBe(0);

    await expect(activeRow.locator('strong')).not.toHaveText(
      'New conversation',
      { timeout: 120_000 },
    );
    const title = await activeRow.locator('strong').textContent();
    expect((title ?? '').length).toBeGreaterThan(0);
    expect((title ?? '').length).toBeLessThanOrEqual(80);
  });
});
