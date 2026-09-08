import { expect, test } from '@playwright/test';

const email = process.env.CHEKKU_E2E_EMAIL;
const password = process.env.CHEKKU_E2E_PASSWORD;
const productionBaseUrl = 'https://app.chekku.rafiqspace.ai';
const runLiveAgentCatalog = process.env.CHEKKU_E2E_AGENT_CATALOG === '1';

if (runLiveAgentCatalog && process.env.CHEKKU_E2E_BASE_URL !== productionBaseUrl) {
  throw new Error(
    `Set CHEKKU_E2E_BASE_URL to ${productionBaseUrl} for live agent-catalog coverage.`,
  );
}

if (runLiveAgentCatalog && (!email || !password)) {
  throw new Error(
    'CHEKKU_E2E_EMAIL and CHEKKU_E2E_PASSWORD are required for live agent-catalog coverage.',
  );
}

test.describe('authenticated agent catalog', () => {
  test.skip(
    !runLiveAgentCatalog,
    'Set CHEKKU_E2E_AGENT_CATALOG=1 to run production authenticated coverage.',
  );

  test('signs in, renders the catalog, and supports filters', async ({ page }) => {
    const catalogResponses = new Map<string, number>();
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (
        pathname === '/api/agent/agents' ||
        pathname === '/api/agent/stored/agents'
      ) {
        catalogResponses.set(pathname, response.status());
      }
    });

    await page.goto(`${productionBaseUrl}/login`);
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password', { exact: true }).fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(`${productionBaseUrl}/agents`);
    await expect
      .poll(() => catalogResponses.get('/api/agent/agents'))
      .toBe(200);
    await expect
      .poll(() => catalogResponses.get('/api/agent/stored/agents'))
      .toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Choose an agent or build your own.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Available agents' }),
    ).toBeVisible();

    const agentCards = page.locator('article.studio-agent-card');
    await expect(agentCards).toHaveCount(5);
    // Regression guard for PR #53: a durable wrapper dropping the agent
    // description used to render this fallback sentence on every card while
    // ids, counts, and tabs all stayed green.
    const descriptionFallback = 'No description has been provided for this agent.';
    for (const agentId of [
      'main-agent',
      'pm-agent',
      'qa-web-agent',
      'qa-android-agent',
      'social-media-supervisor-agent',
    ]) {
      await expect(page.getByText(agentId, { exact: true })).toBeVisible();
      const card = page
        .locator('article.studio-agent-card')
        .filter({ has: page.locator('code', { hasText: agentId }) });
      await expect(card).toHaveCount(1);
      await expect(card).not.toContainText(descriptionFallback);
    }

    const allTab = page.getByRole('tab', { name: /All/ });
    const builtInTab = page.getByRole('tab', { name: /Built-in/ });
    const customTab = page.getByRole('tab', { name: /Custom/ });
    await expect(allTab).toHaveAttribute('aria-selected', 'true');
    await expect(builtInTab).toBeVisible();
    await expect(customTab).toBeVisible();

    const search = page.getByRole('textbox', { name: 'Search agents' });
    await search.fill('main-agent');
    await expect(page.getByText('main-agent', { exact: true })).toBeVisible();
    await expect(page.getByText('pm-agent', { exact: true })).toHaveCount(0);
    await expect(agentCards).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(agentCards).toHaveCount(5);

    await builtInTab.click();
    await expect(builtInTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('main-agent', { exact: true })).toBeVisible();
    await expect(agentCards).toHaveCount(5);

    await customTab.click();
    await expect(customTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'No matching agents' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(allTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentCards).toHaveCount(5);

    await expect(page.getByRole('link', { name: /New agent/ })).toHaveAttribute(
      'href',
      '/agents/new',
    );
  });
});
