// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMocks = vi.hoisted(() => ({
  signInEmail: vi.fn(async () => ({ error: null })),
  signUpEmail: vi.fn(async () => ({ error: null })),
  sendVerificationEmail: vi.fn(async () => ({ error: null })),
}));

const navigationMocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: { email: authMocks.signInEmail },
    signUp: { email: authMocks.signUpEmail },
    useSession: () => ({ data: null, isPending: false }),
    signOut: vi.fn(async () => ({ success: true })),
    sendVerificationEmail: authMocks.sendVerificationEmail,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => navigationMocks.searchParams,
}));

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  navigationMocks.searchParams = new URLSearchParams();
});

describe('login page', () => {
  it('renders an email/password sign-in form and a signup link', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/signup"');
  });

  it('shows that email verification succeeded when redirected from the verification link', async () => {
    navigationMocks.searchParams = new URLSearchParams('verified=1');
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));

    expect(markup).toContain('Your email has been verified. You can sign in now.');
  });

  it('shows a bounded error when the verification link is invalid or expired', async () => {
    navigationMocks.searchParams = new URLSearchParams(
      'verified=1&error=invalid_token&error_description=raw%20provider%20detail',
    );
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));

    expect(markup).toContain(
      'This verification link is invalid or has expired. Request a new link and try again.',
    );
    expect(markup).not.toContain('invalid_token');
    expect(markup).not.toContain('raw provider detail');
    expect(markup).toContain('href="/verify-email"');
  });

  it('does not mislabel unrelated login errors as verification failures', async () => {
    navigationMocks.searchParams = new URLSearchParams('error=other_error');
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));

    expect(markup).not.toContain('verification link is invalid');
    expect(markup).not.toContain('email has been verified');
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

  it('sends successful email verification back to login', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(SignupPage)));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.signUpEmail).toHaveBeenCalledWith({
      email: 'user@example.test',
      password: 'password123',
      name: 'Example User',
      callbackURL: '/login?verified=1',
    });
    expect(authMocks.signUpEmail).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});

describe('verify-email page', () => {
  it('renders the check-your-email state with a resend button', async () => {
    const VerifyPage = (await import('./verify-email/page')).default;
    const markup = renderToStaticMarkup(createElement(VerifyPage));
    expect(markup).toContain('Check your email');
    expect(markup).toMatch(/resend/i);
  });

  it('sends successful email verification back to login when resending', async () => {
    navigationMocks.searchParams = new URLSearchParams();
    const VerifyPage = (await import('./verify-email/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(VerifyPage)));
    const input = container.querySelector('input');
    await act(async () => {
      if (input) setInputValue(input, 'user@example.test');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.sendVerificationEmail).toHaveBeenCalledWith({
      email: 'user@example.test',
      callbackURL: '/login?verified=1',
    });
    expect(authMocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
