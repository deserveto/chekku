import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: { email: vi.fn(async () => ({ error: null })) },
    signUp: { email: vi.fn(async () => ({ error: null })) },
    useSession: () => ({ data: null, isPending: false }),
    signOut: vi.fn(async () => ({ success: true })),
    sendVerificationEmail: vi.fn(async () => ({ error: null })),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === 'status' ? '' : '') }),
}));

describe('login page', () => {
  it('renders an email/password sign-in form and a signup link', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/signup"');
  });
});

describe('signup page', () => {
  it('renders an email/password sign-up form and a login link', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const markup = renderToStaticMarkup(createElement(SignupPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/login"');
  });
});

describe('verify-email page', () => {
  it('renders the check-your-email state with a resend button', async () => {
    const VerifyPage = (await import('./verify-email/page')).default;
    const markup = renderToStaticMarkup(createElement(VerifyPage));
    expect(markup).toContain('Check your email');
    expect(markup).toMatch(/resend/i);
  });
});
