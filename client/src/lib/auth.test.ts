import { describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => ({
  Pool: class {
    constructor(public opts: unknown) {}
  },
}));

describe('buildAuthOptions', () => {
  it('requires email verification and resends on sign-in', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const options = buildAuthOptions({
      secret: 's',
      baseURL: 'https://app.test',
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
    });
    expect(options.baseURL).toBe('https://app.test');
    expect(options.secret).toBe('s');
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.emailVerification?.sendOnSignIn).toBe(true);
  });

  it('delivers verification mail through the injected transport', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const sent: Array<{ user: { email: string }; url: string }> = [];
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async (args) => {
        sent.push(args);
      },
      sendResetPassword: async () => {},
    });

    await options.emailVerification.sendVerificationEmail({
      user: { email: 'person@example.test' },
      url: 'https://app.test/verify?token=abc',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].user).toEqual({ email: 'person@example.test' });
    expect(sent[0].url).toContain('token=abc');
  });

  // Regression: the sign-in resend (`sendOnSignIn`) is issued by Better Auth
  // with no client-supplied callbackURL, so it defaulted to '/' and the login
  // page never saw `verified=1`.
  it('pins every verification link to the login callback', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const { EMAIL_VERIFICATION_CALLBACK_URL } = await import('./auth-redirects');
    const sent: string[] = [];
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async (args) => {
        sent.push(args.url);
      },
      sendResetPassword: async () => {},
    });

    await options.emailVerification.sendVerificationEmail({
      user: { email: 'person@example.test' },
      url: 'https://app.test/api/auth/verify-email?token=abc&callbackURL=%2F',
    });

    const callback = new URL(sent[0]).searchParams.get('callbackURL');
    expect(callback).toBe(EMAIL_VERIFICATION_CALLBACK_URL);
  });

  it('revokes every session when a password is reset', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
    });
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it('delivers reset mail through the injected transport', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const sent: Array<{ user: { email: string }; url: string }> = [];
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async (args) => {
        sent.push(args);
      },
    });

    await options.emailAndPassword?.sendResetPassword?.({
      user: { email: 'person@example.test' },
      url: 'https://app.test/api/auth/reset-password/tok',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].user).toEqual({ email: 'person@example.test' });
    expect(sent[0].url).toContain('reset-password/tok');
  });

  // Without this handler Better Auth awaits email sends inline, which turns
  // the reset endpoint into a timing oracle for registered addresses.
  it('registers background email sends fire-and-forget and swallows their failures', async () => {
    const { buildAuthOptions } = await import('./auth-options');
    const options = buildAuthOptions({
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
      sendVerificationEmail: async () => {},
      sendResetPassword: async () => {},
    });
    const handler = options.advanced?.backgroundTasks?.handler;
    expect(typeof handler).toBe('function');
    if (!handler) return;

    // Registration must return synchronously: an awaited (returned) promise
    // would reintroduce the inline wait the handler exists to remove.
    expect(handler(new Promise<unknown>(() => {}))).toBeUndefined();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      handler(Promise.reject(new Error('send failed')));
      // Drain the microtask/macrotask queues so an unhandled rejection would
      // surface within this test rather than a later one.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
