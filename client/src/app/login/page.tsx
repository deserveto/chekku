'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';
import { authClient } from '@/lib/auth-client';

function LoginContent() {
  const router = useRouter();
  const search = useSearchParams();
  const isVerificationCallback = search.get('verified') === '1';
  const verificationError = isVerificationCallback && search.has('error');
  const verified = isVerificationCallback && !verificationError;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-in failed.');
      return;
    }
    router.push('/agents');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <p className="auth-eyebrow">Sign in</p>
          <h1 className="auth-title">Welcome back</h1>
        </div>
        {verified ? (
          <p className="auth-alert auth-alert-success" role="status">
            Your email has been verified. You can sign in now.
          </p>
        ) : null}
        {verificationError ? (
          <p className="auth-alert auth-alert-error" role="alert">
            <span>
              This verification link is invalid or has expired. Request a new
              link and try again.
            </span>{' '}
            <Link href="/verify-email">Resend verification email.</Link>
          </p>
        ) : null}
        <form className="auth-form" onSubmit={onSubmit}>
          <label className="studio-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <label className="studio-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </label>
          <button className="auth-primary" type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
          {error ? (
            <p className="auth-alert auth-alert-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <p className="auth-foot">
          No account? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
