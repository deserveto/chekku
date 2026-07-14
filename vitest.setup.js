import { TextEncoder, TextDecoder } from 'node:util';

if (!globalThis.TextEncoder) globalThis.TextEncoder = TextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = TextDecoder;

// The Telegram adapter eagerly validates TELEGRAM_BOT_TOKEN at construction
// (social-media-agent.ts builds the adapter at module load). Tests don't call
// Telegram — give them a dummy token so the agent module imports cleanly.
if (!process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
}
