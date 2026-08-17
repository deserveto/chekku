// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMocks = vi.hoisted(() => ({
  signInEmail: vi.fn(async () => ({ error: null })),
  signUpEmail: vi.fn(async () => ({ error: null })),
  sendVerificationEmail: vi.fn(async () => ({ error: null })),
  requestPasswordReset: vi.fn(async () => ({ error: null })),
  resetPassword: vi.fn(async () => ({ error: null })),
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
    requestPasswordReset: authMocks.requestPasswordReset,
    resetPassword: authMocks.resetPassword,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => navigationMocks.searchParams,
}));

// `new URL('./file', import.meta.url)` is rewritten by Vite into an asset URL
// under the jsdom environment, so resolve these source reads from the module
// directory instead.
const appDir = dirname(fileURLToPath(import.meta.url));
const studioCss = readFileSync(join(appDir, 'studio.css'), 'utf8');
const signupSource = readFileSync(join(appDir, 'signup/page.tsx'), 'utf8');

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

  it('uses the premium split auth composition with dedicated welcome artwork', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('class="auth-visual"');
    expect(markup).toContain('Low-poly illuminated path through dark mountains');
    expect(markup).toContain('A calmer place to run your agents.');
  });

  it('links to the forgot-password page under the password field', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).toContain('Forgot password?');
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
      setInputValue(inputs[3], 'password123');
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

  it('renders a confirm password field that must match before sign-up', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(SignupPage)));
    const inputs = container.querySelectorAll('input');
    expect(inputs.length).toBe(4);
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      setInputValue(inputs[3], 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.signUpEmail).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });

  it('recovers from a mismatch once the confirm field is corrected', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(SignupPage)));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'Example User');
      setInputValue(inputs[1], 'user@example.test');
      setInputValue(inputs[2], 'password123');
      setInputValue(inputs[3], 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      setInputValue(inputs[3], 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.signUpEmail).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });

  it('uses distinct new-journey artwork in the shared split composition', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const markup = renderToStaticMarkup(createElement(SignupPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('class="auth-visual"');
    expect(markup).toContain('Low-poly terraced garden rising toward a bright horizon');
    expect(markup).toContain('Build a studio that thinks with you.');
  });

  it('compacts the split composition so laptop viewports fit even with form errors', () => {
    expect(studioCss).toContain('@media (max-height: 950px) and (min-width: 761px)');
    expect(studioCss).toMatch(/max-height: 950px[\s\S]*\.auth-visual\s*\{[^}]*min-height:\s*0/);
  });

  it('keeps tall mobile signup content scrollable inside the viewport', () => {
    expect(studioCss).toMatch(/\.auth-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow-y:\s*auto/);
  });

  it('anchors oversized auth cards to the top so growing forms stay reachable', () => {
    expect(studioCss).toMatch(/\.auth-frame\s*\{[^}]*margin:\s*auto/);
    const shellBlock = studioCss.match(/\.auth-shell\s*\{[^}]*\}/)?.[0] ?? '';
    expect(shellBlock).not.toContain('place-content: center');
  });

  it('pins the visual scrim to fixed lengths so the quote keeps contrast at any card height', () => {
    const shadeBlock = studioCss.match(/\.auth-visual-shade\s*\{[^}]*\}/)?.[0] ?? '';
    expect(shadeBlock).not.toContain('transparent');
    expect(shadeBlock).toContain('200px');
    expect(shadeBlock).toContain('340px');
  });

  it('keeps the verification-success state in the shared auth composition', () => {
    const sharedLayoutUses = signupSource.match(/<AuthLayout/g) ?? [];

    expect(sharedLayoutUses).toHaveLength(2);
    expect(signupSource).not.toContain('className="auth-card"');
  });

  it('gives the post-signup verification state its own artwork', () => {
    expect(signupSource).toContain("verification-low-poly.png");
    expect(signupSource).toContain('Low-poly coastal beacon sending a warm signal at dawn');
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

  it('uses the split auth composition and dedicated verification artwork', async () => {
    const VerifyPage = (await import('./verify-email/page')).default;
    const markup = renderToStaticMarkup(createElement(VerifyPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('auth-verification-panel');
    expect(markup).toContain('Low-poly coastal beacon sending a warm signal at dawn');
    expect(markup).toContain('A clear signal. A private workspace.');
  });
});

describe('forgot-password page', () => {
  it('renders an email form and a back-to-login link', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ForgotPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('href="/login"');
  });

  it('requests a reset link addressed to /reset-password', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ForgotPage)));
    const input = container.querySelector('input');
    await act(async () => {
      if (input) setInputValue(input, 'user@example.test');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.requestPasswordReset).toHaveBeenCalledWith({
      email: 'user@example.test',
      redirectTo: '/reset-password',
    });
    expect(authMocks.requestPasswordReset).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('shows the enumeration-safe success state after submitting', async () => {
    const ForgotPage = (await import('./forgot-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ForgotPage)));
    const input = container.querySelector('input');
    await act(async () => {
      if (input) setInputValue(input, 'user@example.test');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain(
      'If that account exists, a reset link is on its way.',
    );
    await act(async () => root.unmount());
  });
});

describe('reset-password page', () => {
  it('renders the new-password form when a token is present', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ResetPage));
    expect(markup).toContain('type="password"');
    expect(markup).toContain('New password');
    expect(markup).toContain('Confirm password');
  });

  it('shows a bounded invalid-link panel without a token and never renders raw error codes', async () => {
    navigationMocks.searchParams = new URLSearchParams(
      'error=INVALID_TOKEN&error_description=raw%20provider%20detail',
    );
    const ResetPage = (await import('./reset-password/page')).default;
    const markup = renderToStaticMarkup(createElement(ResetPage));
    expect(markup).toContain(
      'This reset link is invalid or has expired. Request a new link and try again.',
    );
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).not.toContain('INVALID_TOKEN');
    expect(markup).not.toContain('raw provider detail');
  });

  it('resets the password through the token on matching inputs', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.resetPassword).toHaveBeenCalledWith({
      newPassword: 'password123',
      token: 'tok123',
    });
    expect(authMocks.resetPassword).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('blocks submit and stays bounded when the passwords do not match', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password999');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(authMocks.resetPassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Passwords do not match.');
    await act(async () => root.unmount());
  });

  it('shows the success panel after resetting', async () => {
    navigationMocks.searchParams = new URLSearchParams('token=tok123');
    const ResetPage = (await import('./reset-password/page')).default;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => root.render(createElement(ResetPage)));
    const inputs = container.querySelectorAll('input[type="password"]');
    await act(async () => {
      setInputValue(inputs[0] as HTMLInputElement, 'password123');
      setInputValue(inputs[1] as HTMLInputElement, 'password123');
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Your password has been reset.');
    expect(container.textContent).toContain('sign in');
    await act(async () => root.unmount());
  });
});
