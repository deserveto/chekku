import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Load env files using the module's own directory rather than process.cwd().
// When scripts/dev.sh runs `npm run dev:agent` inside a tmux pane with cwd set
// to the repo root, dotenv's default cwd-based lookup fails to find agent/.env
// — which silently drops keys like WEB_READER_BASE_URL. Resolving relative to
// import.meta.url is deterministic regardless of where the process was
// launched from. `quiet: true` also suppresses dotenv v17's promotional
// `◇ injected env (N) from path // tip: …` log line.
const moduleDir = dirname(fileURLToPath(import.meta.url));

// Apply dotenv files in order; missing files are skipped without error.
//
// A key already set in process.env always wins — dotenv's own default. With
// `fillEmpty`, a key present but *empty* is also treated as unset, so a later
// file can supply a value for a placeholder without ever discarding a value the
// operator or developer chose deliberately (agent/.env.example documents
// setting DATABASE_URL to point at a remote Postgres, and an exported shell
// value must survive too). A blanket `override` would take both.
//
// Exported so the precedence contract can be pinned by regression tests.
export function applyEnvFiles(
  files: ReadonlyArray<{ path: string; fillEmpty?: boolean }>,
): void {
  for (const { path, fillEmpty } of files) {
    if (!path || !existsSync(path)) continue;
    if (!fillEmpty) {
      config({ path, quiet: true });
      continue;
    }
    // Parse into a throwaway object so nothing is written until each key has
    // been checked against what is already in process.env.
    const parsed = config({ path, quiet: true, processEnv: {} }).parsed ?? {};
    for (const [key, value] of Object.entries(parsed)) {
      const current = process.env[key];
      if (current === undefined || current === '') process.env[key] = value;
    }
  }
}

// Base user-owned secrets. No override: values already present in process.env
// (e.g. the production container's Compose environment) are preserved.
applyEnvFiles([{ path: resolve(moduleDir, '../../.env') }]);

// Dev-only generated values. scripts/setup-env.sh writes the generated
// DATABASE_URL (plus Garage/SearXNG coordinates) to agent/.env.development,
// not agent/.env (which keeps an empty DATABASE_URL placeholder). The Mastra
// dev server does not reliably load .env.development into process.env before
// this module runs, so load it here with `fillEmpty` so the generated
// DATABASE_URL fills the placeholder. Without this, env.DATABASE_URL silently
// falls back to the schema default and PostgresStore fails auth. `fillEmpty`
// rather than a blanket override: a DATABASE_URL the developer exported or set
// non-empty in agent/.env stays in force, per the same rule setup-env.sh
// already follows for SEARXNG_API_KEY.
// Gated on NODE_ENV as a second line of defence so the file is not read at all
// under the production container env or a normal test run; the file is also
// gitignored.
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  applyEnvFiles([
    { path: resolve(moduleDir, '../../.env.development'), fillEmpty: true },
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
  // Base URL of the self-hosted Jina Reader OSS container (HTTP/1.1 endpoint,
  // e.g. `http://127.0.0.1:8081` in dev or `http://reader:8081` in compose).
  // Empty/unset → read_web_page fails closed with a fixed configuration error.
  // No API key; the local Reader service is unauthenticated.
  WEB_READER_BASE_URL: z.string().default(''),

  // Knowledge Base vector index (Qdrant). Empty/unset → every knowledge
  // tool and the ingestion workflow fail closed with a fixed configuration
  // error, exactly like SEARXNG_BASE_URL and WEB_READER_BASE_URL. The
  // optional API key is only needed for Qdrant deployments with auth
  // enabled; the local Compose service runs without one.
  QDRANT_URL: optionalUrl.default(''),
  QDRANT_API_KEY: z.string().default(''),
  QDRANT_COLLECTION: z.string().default('chekku_knowledge'),
  // Embedding model for Knowledge Base ingestion and query embedding,
  // resolved against LLM_BASE_URL + LLM_API_KEY (/embeddings). Empty/unset
  // → the Knowledge Base fails closed; no silent calls to an unconfigured
  // model. Changing the model changes the vector dimension: the ingestion
  // pipeline validates the configured collection and refuses to corrupt it.
  LLM_EMBEDDING_MODEL: z.string().default(''),

  // Public Holiday Indonesia API base URL. Optional — when unset, the
  // weekly-social-drafts workflow falls back to the hardcoded SPECIAL_DAYS
  // calendar only (no movable feasts like Idul Fitri / Idul Adha).
  PUBLIC_HOLIDAY_API_BASE_URL: z.string().default('https://api-hari-libur.vercel.app/api'),

  // Local filesystem directory for the per-year holiday cache. Relative to
  // the agent workspace working directory. The directory and its contents
  // are gitignored generated state.
  PUBLIC_HOLIDAY_CACHE_DIR: z.string().default('src/mastra/calendar/.cache'),

  CHEKKU_DEFAULT_AGENT_ID: z.string().default('main-agent'),
  // Per-user daily token quota (input + output tokens summed per resourceId
  // per UTC day) enforced at run start. Empty/unset falls back to the default;
  // 0 disables enforcement. Counters are
  // in-memory; an agent server restart gives users a fresh daily quota.
  TOKEN_DAILY_LIMIT: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().min(0).default(500_000),
  ),
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
