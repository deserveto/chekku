import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.CHEKKU_E2E_BASE_URL ?? 'http://localhost:3000';

// The webServer readiness poll stays on the local origin that
// `npm run dev:client` serves; CHEKKU_E2E_BASE_URL only retargets the browser,
// so an override pointing at another origin never stalls the startup poll.
const webServerURL = 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev:client',
    url: webServerURL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
