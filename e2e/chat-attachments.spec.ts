import { expect, test } from '@playwright/test';
import {
  createVerifiedChatSession,
  deleteChatSessionUser,
  openMainAgentChat,
  sendChatTurn,
} from './helpers/chat-session';
import { buildTwoPagePdf } from './helpers/test-pdf';

/**
 * E2E for the PDF attachment lifecycle: a sent PDF must render as ONE
 * compact card in the live timeline, still ONE card after a page refresh
 * (Mastra persistence strips part filenames, so restore groups pages from
 * the surviving attachment-label manifest), and the card must open the PDF
 * sidebar viewer over the authenticated original route.
 */
test.describe('pdf attachment lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  let testEmail: string;

  test.afterAll(async () => {
    await deleteChatSessionUser(testEmail);
  });

  test('keeps a sent pdf as one compact card across refresh and opens the sidebar viewer', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    testEmail = await createVerifiedChatSession(page, 'pdf');
    await openMainAgentChat(page);

    await page.getByRole('button', { name: 'Attach files' }).click();
    await page.setInputFiles('input[type="file"]', {
      name: 'chekku-e2e.pdf',
      mimeType: 'application/pdf',
      buffer: buildTwoPagePdf(),
    });
    await expect(page.getByText('chekku-e2e.pdf (2 pages)')).toBeVisible();

    await sendChatTurn(
      page,
      'Summarize the attached PDF in one short sentence.',
    );

    // Live timeline: ONE pdf card, never exploded page images.
    const liveCard = page.locator('.chat-pdf-card').first();
    await expect(liveCard).toBeVisible({ timeout: 30_000 });
    // The card stays disabled until the Knowledge upload returns its
    // documentId (or page images exist); opening requires that linkage.
    await expect(liveCard).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('.chat-pdf-card')).toHaveCount(1);
    await expect(page.locator('img[alt*="(page 2 of 2)"]')).toHaveCount(0);

    // Sidebar viewer over the live card: the upload created the Knowledge
    // document, so the viewer serves the authenticated original inline.
    // force: the knowledge-status poll re-renders the row every 3s, which
    // keeps the card in Playwright's "unstable" bucket forever.
    await liveCard.click({ force: true });
    const viewer = page.locator('dialog.chat-pdf-viewer[open]');
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByRole('heading', { name: /chekku-e2e\.pdf/ }),
    ).toBeVisible();
    const frame = viewer.locator('iframe.chat-pdf-frame');
    await expect(frame).toBeVisible();
    await expect
      .poll(async () => frame.getAttribute('src'), { timeout: 30_000 })
      .toMatch(/\/api\/storage\/knowledge\/documents\/.+\/original/);
    await page.keyboard.press('Escape');
    await expect(viewer).not.toBeVisible();

    // Wait out the full turn so the user message is persisted, then reload:
    // the restored thread must still show exactly one compact card.
    await expect
      .poll(
        async () =>
          page
            .getByRole('navigation', { name: 'Conversation history' })
            .locator('.chat-thread-status')
            .count(),
        { timeout: 180_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toBe(0);

    await page.reload();
    const restoredCard = page.locator('.chat-pdf-card').first();
    await expect(restoredCard).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.chat-pdf-card')).toHaveCount(1);
    await expect(page.locator('img[alt*="(page 2 of 2)"]')).toHaveCount(0);
    await expect(restoredCard).toContainText('chekku-e2e.pdf');
    await expect(restoredCard).toContainText('2 pages');

    await restoredCard.click({ force: true });
    await expect(
      page.locator('dialog.chat-pdf-viewer[open]'),
    ).toBeVisible();
    await expect(
      page
        .locator('dialog.chat-pdf-viewer[open]')
        .getByRole('heading', { name: /chekku-e2e\.pdf/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
