// Shared Better Auth configuration. Deliberately free of `import 'server-only'`
// and of any import that reaches it: @better-auth/cli loads this module (through
// auth-migrate.ts) to derive the schema, and it aborts on any config whose
// import graph touches `server-only`. Runtime server code composes these options
// with the real email transport in auth.ts, which keeps the `server-only` guard.
import { Pool } from 'pg';
import { withEmailVerificationCallback } from './auth-redirects';

interface SendVerificationEmail {
  (args: { user: { email: string }; url: string }): Promise<void>;
}

interface BuildAuthOptionsArgs {
  secret?: string;
  baseURL?: string;
  connectionString?: string;
  // Required rather than defaulted: a no-op fallback would silently disable
  // verification delivery, and every signup depends on that mail arriving.
  sendVerificationEmail: SendVerificationEmail;
}

export function buildAuthOptions(args: BuildAuthOptionsArgs) {
  return {
    baseURL: args.baseURL,
    secret: args.secret,
    database: new Pool({ connectionString: args.connectionString }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    emailVerification: {
      sendOnSignIn: true,
      // Pin the callback on every outgoing link rather than at each call site:
      // the `sendOnSignIn` resend is issued by Better Auth itself and no client
      // call can parameterise it. See `withEmailVerificationCallback`.
      sendVerificationEmail: async (verification: {
        user: { email: string };
        url: string;
      }) => {
        await args.sendVerificationEmail({
          user: verification.user,
          url: withEmailVerificationCallback(verification.url),
        });
      },
    },
  };
}
