import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('sendVerificationEmail', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('posts to Resend with the configured sender when RESEND_API_KEY is set', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendVerificationEmail } = await import('./email');
    await sendVerificationEmail({
      to: 'user@example.test',
      url: 'https://app.test/api/auth/verify-email?token=x',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer rk_test',
    );
    const body = JSON.parse(init!.body as string);
    expect(body.from).toBe('no-reply@chekku.test');
    expect(body.to).toEqual(['user@example.test']);
    expect(body.html).toContain('https://app.test/api/auth/verify-email?token=x');
  });

  it('logs the url and skips Resend when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendVerificationEmail } = await import('./email');
    await sendVerificationEmail({
      to: 'user@example.test',
      url: 'https://app.test/v?token=y',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('https://app.test/v?token=y'),
    );
  });

  it('throws a fixed message when Resend rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    globalThis.fetch = fetchMock;

    const { sendVerificationEmail } = await import('./email');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.toThrow('Failed to send verification email.');
  });

  it('cancels the response body when Resend rejects to avoid leaking the undici connection', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('boom'));
      },
    });
    const cancelSpy = vi.spyOn(body, 'cancel');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 500 }));
    globalThis.fetch = fetchMock;

    const { sendVerificationEmail } = await import('./email');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.toThrow('Failed to send verification email.');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('throws a fixed message without leaking the endpoint when fetch rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: 'api.resend.com' }),
      );
    globalThis.fetch = fetchMock;

    const { sendVerificationEmail } = await import('./email');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.toThrow('Failed to send verification email.');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.not.toThrow(/api\.resend\.com/);
  });

  it('throws a fixed message and skips fetch when RESEND_FROM_EMAIL is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendVerificationEmail } = await import('./email');
    await expect(
      sendVerificationEmail({ to: 'u@e.test', url: 'https://app.test/v' }),
    ).rejects.toThrow('Failed to send verification email.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendResetPasswordEmail', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('posts to Resend with the reset subject and link when RESEND_API_KEY is set', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock;

    const { sendResetPasswordEmail } = await import('./email');
    await sendResetPasswordEmail({
      to: 'user@example.test',
      url: 'https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset-password',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.subject).toBe('Reset your Chekku password');
    expect(body.to).toEqual(['user@example.test']);
    expect(body.html).toContain(
      'https://app.test/api/auth/reset-password/tok?callbackURL=%2Freset-password',
    );
  });

  it('logs the url and skips Resend when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendResetPasswordEmail } = await import('./email');
    await sendResetPasswordEmail({
      to: 'user@example.test',
      url: 'https://app.test/reset?token=y',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('https://app.test/reset?token=y'),
    );
  });

  it('throws a fixed message when Resend rejects', async () => {
    vi.stubEnv('RESEND_API_KEY', 'rk_test');
    vi.stubEnv('RESEND_FROM_EMAIL', 'no-reply@chekku.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    globalThis.fetch = fetchMock;

    const { sendResetPasswordEmail } = await import('./email');
    await expect(
      sendResetPasswordEmail({
        to: 'u@e.test',
        url: 'https://app.test/reset?token=z',
      }),
    ).rejects.toThrow('Failed to send reset password email.');
  });
});
