'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';
import { authClient } from '@/lib/auth-client';
import { EMAIL_VERIFICATION_CALLBACK_URL } from '@/lib/auth-redirects';

function VerifyEmailContent() {
  const search = useSearchParams();
  const verified = search.get('status') === 'verified';
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: EMAIL_VERIFICATION_CALLBACK_URL,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Could not resend verification email.');
      return;
    }
    setSent(true);
  }

  if (verified) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark />
            <p className="auth-eyebrow">Verified</p>
            <h1 className="auth-title">Email confirmed</h1>
          </div>
          <p className="auth-subtitle">
            Your email is verified. You can sign in now.
          </p>
          <p className="auth-foot">
            <Link href="/login">Sign in</Link>
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
          <p className="auth-eyebrow">Verify email</p>
          <h1 className="auth-title">Check your email</h1>
        </div>
        <p className="auth-subtitle">
          We sent a verification link when you signed up. Click it to verify
          your account.
        </p>
        <form className="auth-form" onSubmit={onResend}>
          <label className="studio-field">
            <span>Resend to</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@example.com"
            />
          </label>
          <button className="auth-primary" type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Resend verification'}
          </button>
          {sent ? (
            <p className="auth-alert auth-alert-success" role="status">
              If that account exists, a new link is on its way.
            </p>
          ) : null}
          {error ? (
            <p className="auth-alert auth-alert-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <p className="auth-foot">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
