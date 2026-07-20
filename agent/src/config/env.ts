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

  CHEKKU_DEFAULT_AGENT_ID: z.string().default('main-agent'),
  CHEKKU_LOCAL_USER_ID: z.string().default('local-user'),
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true'),

  GARAGE_ENDPOINT: optionalUrl.default(''),
  GARAGE_REGION: z.string().default(''),
  GARAGE_BUCKET: z.string().default(''),
  GARAGE_ACCESS_KEY_ID: z.string().default(''),
  GARAGE_SECRET_ACCESS_KEY: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  return envSchema.parse(source);
}

export const env: Env = loadEnv();
