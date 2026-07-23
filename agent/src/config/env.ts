import 'dotenv/config';
import { z } from 'zod';

const optionalUrl = z.union([z.string().url(), z.literal('')]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4111),
  HOST: z.string().default('localhost'),
  DATABASE_URL: z.string().default('file:./mastra.db'),
  DATABASE_AUTH_TOKEN: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  LLM_BASE_URL: optionalUrl.default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_DEFAULT_MODEL: z.string().default(''),
  LLM_DISPLAY_NAME: z.string().default('OpenAI-compatible endpoint'),
  LLM_MODELS: z.string().default(''),

  SEARXNG_BASE_URL: z.string().default(''),
  SEARXNG_API_KEY: z.string().default(''),
  WEB_READER_API_KEY: z.string().default(''),

  // Public Holiday Indonesia API base URL. Optional — when unset, the
  // weekly-social-drafts workflow falls back to the hardcoded SPECIAL_DAYS
  // calendar only (no movable feasts like Idul Fitri / Idul Adha).
  PUBLIC_HOLIDAY_API_BASE_URL: z.string().default('https://api-hari-libur.vercel.app/api'),

  // Local filesystem directory for the per-year holiday cache. Relative to
  // the agent workspace working directory. The directory and its contents
  // are gitignored generated state.
  PUBLIC_HOLIDAY_CACHE_DIR: z.string().default('src/mastra/calendar/.cache'),

  CHEKKU_DEFAULT_AGENT_ID: z.string().default('main-agent'),
  CHEKKU_LOCAL_USER_ID: z.string().default('local-user'),
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true'),

  MAESTRO_ENABLED: z.enum(['true', 'false']).default('false'),
  MAESTRO_COMMAND: z.string().default('maestro'),
  MAESTRO_WORKSPACE: z.string().default('../maestro'),
  MAESTRO_ARTIFACT_DIR: z.string().default('../artifacts/maestro'),
  MAESTRO_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
  ADB_PATH: z.string().default('adb'),

  GARAGE_ENDPOINT: optionalUrl.default(''),
  GARAGE_REGION: z.string().default(''),
  GARAGE_BUCKET: z.string().default(''),
  GARAGE_ACCESS_KEY_ID: z.string().default(''),
  GARAGE_SECRET_ACCESS_KEY: z.string().default(''),

  // Recipient of the weekly social-draft review email (scheduled workflow).
  // Required per environment — there is no default. When unset, the workflow
  // still drafts and saves posts but skips the email step.
  SOCIAL_DRAFT_REVIEW_EMAIL: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  return envSchema.parse(source);
}

export const env: Env = loadEnv();
