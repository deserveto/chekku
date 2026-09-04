import { readFileSync } from 'node:fs';
import { isIP as netIsIP } from 'node:net';
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

/** Refuse anything but a loopback host before the suite runs UPDATE/DELETE. */
function assertLoopbackDatabaseUrl(connectionString: string): void {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new Error('Auth database URL is not a valid URL.');
  }
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    (/^127\.\d+\.\d+\.\d+$/.test(hostname) && Boolean(netIsIP(hostname)));
  if (!isLoopback) {
    throw new Error(
      'E2E auth database URL must point at a loopback host (localhost / 127.0.0.1 / ::1); refusing to touch a remote database.',
    );
  }
}

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= (() => {
    const connectionString = resolveAuthDatabaseUrl();
    assertLoopbackDatabaseUrl(connectionString);
    return new Pool({ connectionString, max: 1 });
  })();
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

export async function countUsersByEmail(email: string): Promise<number> {
  const result = await getPool().query(
    'SELECT COUNT(*)::int AS count FROM "user" WHERE "email" = $1',
    [email],
  );
  return result.rows[0]?.count ?? 0;
}

export async function deleteTestUser(email: string): Promise<void> {
  const client = getPool();
  // Reset-password rows use `reset-password:<token>` identifiers with the user
  // id in `value` (email-verification tokens are stateless JWTs), and the
  // verification table has no FK to `user` — sweep before the user delete.
  await client.query(
    `DELETE FROM "verification"
     WHERE "identifier" LIKE 'reset-password:%'
       AND "value" IN (SELECT "id" FROM "user" WHERE "email" = $1)`,
    [email],
  );
  await client.query('DELETE FROM "user" WHERE "email" = $1', [email]);
}

export async function sweepStaleTestUsers(): Promise<void> {
  const client = getPool();
  await client.query(
    `DELETE FROM "verification"
     WHERE "value" IN (SELECT "id" FROM "user" WHERE "email" LIKE 'e2e-%@chekku.test')`,
  );
  await client.query(
    `DELETE FROM "user" WHERE "email" LIKE 'e2e-%@chekku.test'`,
  );
}

export async function closeAuthDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
