import { MastraClient } from '@mastra/client-js';

/**
 * Browser traffic targets the Next.js origin. The server-only proxy forwards
 * requests to AGENT_URL and can attach a downstream service credential.
 */
export const mastraBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const mastraClient = new MastraClient({
  baseUrl: mastraBaseUrl,
  apiPrefix: '/api/agent',
  retries: 2,
  backoffMs: 300,
  maxBackoffMs: 2_000,
});
