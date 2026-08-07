import { createElement } from 'react';
import { readFileSync } from 'node:fs';
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

const studioCss = readFileSync(new URL('./studio.css', import.meta.url), 'utf8');
const signupSource = readFileSync(new URL('./signup/page.tsx', import.meta.url), 'utf8');

describe('login page', () => {
  it('renders an email/password sign-in form and a signup link', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('href="/signup"');
  });

  it('uses the premium split auth composition with dedicated welcome artwork', async () => {
    const LoginPage = (await import('./login/page')).default;
    const markup = renderToStaticMarkup(createElement(LoginPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('class="auth-visual"');
    expect(markup).toContain('Low-poly illuminated path through dark mountains');
    expect(markup).toContain('A calmer place to run your agents.');
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

  it('uses distinct new-journey artwork in the shared split composition', async () => {
    const SignupPage = (await import('./signup/page')).default;
    const markup = renderToStaticMarkup(createElement(SignupPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('class="auth-visual"');
    expect(markup).toContain('Low-poly terraced garden rising toward a bright horizon');
    expect(markup).toContain('Build a studio that thinks with you.');
  });

  it('fits the split composition inside short desktop viewports', () => {
    expect(studioCss).toContain('@media (max-height: 800px) and (min-width: 761px)');
    expect(studioCss).toMatch(/max-height: 800px[\s\S]*\.auth-visual\s*\{[^}]*min-height:\s*0/);
  });

  it('keeps tall mobile signup content scrollable inside the viewport', () => {
    expect(studioCss).toMatch(/\.auth-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow-y:\s*auto/);
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

  it('uses the split auth composition and dedicated verification artwork', async () => {
    const VerifyPage = (await import('./verify-email/page')).default;
    const markup = renderToStaticMarkup(createElement(VerifyPage));

    expect(markup).toContain('class="auth-frame"');
    expect(markup).toContain('auth-verification-panel');
    expect(markup).toContain('Low-poly coastal beacon sending a warm signal at dawn');
    expect(markup).toContain('A clear signal. A private workspace.');
  });
});
