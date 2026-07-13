import { AgentBrowser } from '@mastra/agent-browser';

export const browser = new AgentBrowser({
  headless: process.env.BROWSER_HEADLESS !== 'false',
  screencast: {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
  },
});
