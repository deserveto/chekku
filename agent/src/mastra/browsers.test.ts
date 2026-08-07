import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: Array<Record<string, unknown>> = [];

vi.mock('@mastra/agent-browser', () => ({
  AgentBrowser: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config);
    }
  },
}));

const originalExecutablePath = process.env.BROWSER_EXECUTABLE_PATH;

async function loadBrowser(): Promise<Record<string, unknown>> {
  vi.resetModules();
  constructed.length = 0;
  await import('./browsers.js');
  expect(constructed).toHaveLength(1);
  return constructed[0];
}

beforeEach(() => {
  delete process.env.BROWSER_EXECUTABLE_PATH;
});

afterEach(() => {
  if (originalExecutablePath === undefined) {
    delete process.env.BROWSER_EXECUTABLE_PATH;
  } else {
    process.env.BROWSER_EXECUTABLE_PATH = originalExecutablePath;
  }
});

describe('agent browser', () => {
  it('launches the configured system browser', async () => {
    // playwright-core resolves its own bundled download unless it is handed an
    // explicit executablePath; it has no environment variable for pointing at a
    // system binary. Without this, the agent image's Chromium is never used and
    // every browser tool fails with "Executable doesn't exist at
    // /root/.cache/ms-playwright/...".
    process.env.BROWSER_EXECUTABLE_PATH = '/usr/bin/chromium';

    const config = await loadBrowser();

    expect(config.executablePath).toBe('/usr/bin/chromium');
  });

  it('leaves executablePath unset when no system browser is configured', async () => {
    // Host development relies on Playwright's own downloaded browser; passing an
    // empty string would make it launch a non-existent executable.
    const config = await loadBrowser();

    expect(config.executablePath).toBeUndefined();
  });
});
