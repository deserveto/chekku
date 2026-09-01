import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvLocalValue(key: string): string | undefined {
  const envPath = join(process.cwd(), 'client', '.env.local');
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return undefined;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rawLine.trim());
    if (match && match[1] === key) {
      return stripQuotes(match[2].trim());
    }
  }
  return undefined;
}

export function resolveAuthDatabaseUrl(): string {
  const override = process.env.CHEKKU_E2E_AUTH_DATABASE_URL;
  if (override) return override;
  const fromProcessEnv = process.env.AUTH_DATABASE_URL;
  if (fromProcessEnv) return fromProcessEnv;
  const fromEnvLocal = readEnvLocalValue('AUTH_DATABASE_URL');
  if (fromEnvLocal) return fromEnvLocal;
  throw new Error(
    'AUTH_DATABASE_URL not found. Run npm run setup first, or export CHEKKU_E2E_AUTH_DATABASE_URL.',
  );
}

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: resolveAuthDatabaseUrl(), max: 1 });
  return pool;
}

export async function markEmailVerified(email: string): Promise<void> {
  const result = await getPool().query(
    'UPDATE "user" SET "emailVerified" = TRUE WHERE "email" = $1',
    [email],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected exactly one test user for ${email}, found ${result.rowCount}.`,
    );
  }
}

export async function deleteTestUser(email: string): Promise<void> {
  const client = getPool();
  await client.query('DELETE FROM "verification" WHERE "identifier" = $1', [
    email,
  ]);
  await client.query('DELETE FROM "user" WHERE "email" = $1', [email]);
}

export async function closeAuthDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
