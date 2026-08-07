import { AgentBrowser } from '@mastra/agent-browser';
import { env } from '../config/env.js';

export const browser = new AgentBrowser({
  headless: env.BROWSER_HEADLESS !== 'false',
  // Must be omitted rather than passed empty: an empty string would make
  // Playwright launch a non-existent executable instead of falling back to its
  // own downloaded browser.
  executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
  screencast: {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
  },
});
