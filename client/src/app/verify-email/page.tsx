'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';

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
      callbackURL: '/verify-email',
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
      <AuthLayout
        image={verificationArtwork}
        imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
        eyebrow="Verified"
        title="Email confirmed."
        description="Your identity is confirmed and your private workspace is ready."
        quote="A clear signal. A private workspace."
      >
        <div className="auth-result auth-verification-panel">
          <p className="auth-verification-status">Verification complete</p>
          <p className="auth-description">
            Your email is verified. You can sign in now.
          </p>
          <Link className="auth-primary" href="/login">Sign in</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      image={verificationArtwork}
      imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
      eyebrow="Verify email"
      title="Check your email."
      description="Use the link we sent, or request a fresh one below."
      quote="A clear signal. A private workspace."
    >
      <div className="auth-result auth-verification-panel">
        <p className="auth-verification-status">Waiting for confirmation</p>
        <p className="auth-description">
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
    </AuthLayout>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
