import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(public opts: unknown) {}
  },
}));
vi.mock('better-auth', () => ({
  betterAuth: (opts: unknown) => ({ __mockedAuth: true, opts }),
}));

describe('buildAuthOptions', () => {
  it('requires email verification and resends on sign-in', async () => {
    const { buildAuthOptions } = await import('./auth');
    const options = buildAuthOptions({
      secret: 's',
      baseURL: 'https://app.test',
      connectionString: 'postgresql://u:p@h:5432/chekku_auth',
    });
    expect(options.baseURL).toBe('https://app.test');
    expect(options.secret).toBe('s');
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.emailVerification?.sendOnSignIn).toBe(true);
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe(
      'function',
    );
  });
});
