import 'server-only';
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from './auth-options';
import { sendResetPasswordEmail, sendVerificationEmail } from '@/server/email';

export const auth = betterAuth(
  buildAuthOptions({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    connectionString: process.env.AUTH_DATABASE_URL,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, url });
    },
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail({ to: user.email, url });
    },
  }),
);
