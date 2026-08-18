'use client';

import Link from 'next/link';
import { useState } from 'react';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (error) {
      setError('Failed to send reset email. Try again in a minute.');
      return;
    }
    setSent(true);
  }

  return (
    <AuthLayout
      image={verificationArtwork}
      imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
      eyebrow="Password reset"
      title="Forgot your password?"
      description="Enter your email and we will send a reset link."
      quote="A clear signal. A private workspace."
    >
      <div className="auth-result auth-verification-panel">
        {sent ? (
          <>
            <p className="auth-verification-status">Reset link requested</p>
            <p className="auth-alert auth-alert-success" role="status">
              If that account exists, a reset link is on its way. It expires in
              one hour and works once.
            </p>
          </>
        ) : (
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
            <button className="auth-primary" type="submit" disabled={pending}>
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
            {error ? (
              <p className="auth-alert auth-alert-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
        <p className="auth-foot">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
