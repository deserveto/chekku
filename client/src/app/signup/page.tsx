'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';
import { authClient } from '@/lib/auth-client';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: '/verify-email',
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed.');
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark />
            <p className="auth-eyebrow">Almost there</p>
            <h1 className="auth-title">Check your email</h1>
          </div>
          <p className="auth-subtitle">
            We sent a verification link to <strong>{email}</strong>. Click it to
            verify your account, then sign in.
          </p>
          <p className="auth-alert auth-alert-success" role="status">
            If you don&apos;t see the email within a minute, check your spam
            folder.
          </p>
          <p className="auth-foot">
            <Link href="/login">Back to sign in</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <p className="auth-eyebrow">Create account</p>
          <h1 className="auth-title">Join Chekku</h1>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          <label className="studio-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="name"
              placeholder="Your name"
            />
          </label>
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
              autoComplete="new-password"
              minLength={8}
              placeholder="At least 8 characters"
            />
          </label>
          <button className="auth-primary" type="submit" disabled={pending}>
            {pending ? 'Creating account…' : 'Create account'}
          </button>
          {error ? (
            <p className="auth-alert auth-alert-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <p className="auth-foot">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
