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
    });

    await options.emailVerification.sendVerificationEmail({
      user: { email: 'person@example.test' },
      url: 'https://app.test/verify?token=abc',
    });

    expect(sent).toEqual([
      {
        user: { email: 'person@example.test' },
        url: 'https://app.test/verify?token=abc',
      },
    ]);
  });
});
