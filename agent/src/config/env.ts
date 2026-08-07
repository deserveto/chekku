import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Load env files using the module's own directory rather than process.cwd().
// When scripts/dev.sh runs `npm run dev:agent` inside a tmux pane with cwd set
// to the repo root, dotenv's default cwd-based lookup fails to find agent/.env
// — which silently drops keys like WEB_READER_API_KEY. Resolving relative to
// import.meta.url is deterministic regardless of where the process was
// launched from. `quiet: true` also suppresses dotenv v17's promotional
// `◇ injected env (N) from path // tip: …` log line.
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Apply dotenv files in order. Later files override earlier ones only when
// `override` is set; missing files are skipped without error. Exported so the
// precedence contract (the generated DATABASE_URL must win over the empty
// placeholder in agent/.env) can be pinned by regression tests.
export function applyEnvFiles(
  files: ReadonlyArray<{ path: string; override?: boolean }>,
): void {
  for (const { path, override } of files) {
    if (!path || !existsSync(path)) continue;
    config({ path, quiet: true, override: override ?? false });
  }
}

// Base user-owned secrets. No override: values already present in process.env
// (e.g. the production container's Compose environment) are preserved.
applyEnvFiles([{ path: resolve(moduleDir, '../../.env') }]);

// Dev-only generated values. scripts/setup-env.sh writes the generated
// DATABASE_URL (plus Garage/SearXNG coordinates) to agent/.env.development,
// not agent/.env (which keeps an empty DATABASE_URL placeholder). The Mastra
// dev server does not reliably load .env.development into process.env before
// this module runs, so load it here with override so the generated
// DATABASE_URL wins over the placeholder. Without this, env.DATABASE_URL
// silently falls back to the schema default and PostgresStore fails auth.
// Gated on NODE_ENV so the file is only applied for the dev server: it must
// never override the production container env, and it must not pollute
// process.env during the test run (vitest sets NODE_ENV=test). The file is
// also gitignored.
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  applyEnvFiles([
    { path: resolve(moduleDir, '../../.env.development'), override: true },
  ]);
}

const optionalUrl = z.union([z.string().url(), z.literal('')]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4111),
  HOST: z.string().default('localhost'),
  DATABASE_URL: z
    .string()
    .default('postgresql://chekku:postgres@localhost:5432/chekku_agent'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEB_URL: z.string().url().default('http://localhost:3000'),

  LLM_BASE_URL: optionalUrl.default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_DEFAULT_MODEL: z.string().default(''),
  LLM_DISPLAY_NAME: z.string().default('OpenAI-compatible endpoint'),
  LLM_MODELS: z.string().default(''),

  // Fixed image-generation model invoked by the Visual Content Agent's
  // `generate_image` tool. The model never comes from tool/model input.
  // Empty/unset → the tool fails closed with a fixed configuration error, so
  // an operator who never sets the var does not get a silent live call to a
  // model the gateway may not have.
  LLM_IMAGE_MODEL: z.string().default(''),
  // Narrowly-scoped server-only path under LLM_BASE_URL for image generation.
  // Defaults to the OpenAI Images API standard path; override only when the
  // configured gateway exposes images under a different path.
  LLM_IMAGE_ENDPOINT_PATH: z.string().default('/images/generations'),

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
  BROWSER_HEADLESS: z.enum(['true', 'false']).default('true'),
  // Absolute path to a system browser binary. playwright-core resolves its own
  // downloaded browser unless it is handed an explicit executablePath, and it
  // has no environment variable for pointing at a system install — so the agent
  // image passes its Chromium through here. Empty means "use Playwright's own
  // download", which is what host development wants.
  BROWSER_EXECUTABLE_PATH: z.string().default(''),

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
