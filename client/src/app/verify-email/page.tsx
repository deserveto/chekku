'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
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
      <main>
        <h1>Email verified</h1>
        <p>Your email is verified. You can sign in now.</p>
        <p>
          <Link href="/login">Sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Check your email</h1>
      <p>
        We sent a verification link when you signed up. Click it to verify your
        account.
      </p>
      <form onSubmit={onResend}>
        <label>
          Resend to
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Resend verification'}
        </button>
        {sent ? <p>If that account exists, a new link is on its way.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p>
        <Link href="/login">Back to sign in</Link>
      </p>
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
