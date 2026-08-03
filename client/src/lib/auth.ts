import 'server-only';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { sendVerificationEmail } from '@/server/email';

interface BuildAuthOptionsArgs {
  secret?: string;
  baseURL?: string;
  connectionString?: string;
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
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string };
        url: string;
      }) => {
        await sendVerificationEmail({ to: user.email, url });
      },
    },
  };
}

export const auth = betterAuth(
  buildAuthOptions({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    connectionString: process.env.AUTH_DATABASE_URL,
  }),
);
