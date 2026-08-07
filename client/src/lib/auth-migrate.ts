// Schema-only Better Auth config, loaded exclusively by `npm run db:migrate`
// (see scripts/db-migrate.sh). It exists because @better-auth/cli cannot load
// auth.ts: that module imports `server-only` directly and again transitively
// through @/server/email, and the CLI aborts with "Please remove import
// 'server-only' from your auth config file" regardless of resolution
// conditions.
//
// It shares buildAuthOptions with auth.ts, so the tables the CLI emits cannot
// drift from the runtime configuration. Only the email transport differs, and
// that has no effect on schema: the generated tables come from the adapter,
// emailAndPassword, and the (empty) plugin list.
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from './auth-options';

export const auth = betterAuth(
  buildAuthOptions({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    connectionString: process.env.AUTH_DATABASE_URL,
    // Never invoked — the CLI derives the schema without sending mail.
    sendVerificationEmail: async () => {},
  }),
);
