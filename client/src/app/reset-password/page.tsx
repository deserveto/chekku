'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';

const INVALID_LINK_MESSAGE =
  'This reset link is invalid or has expired. Request a new link and try again.';
// Better Auth enforces 8-128 password characters server-side
// (`PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG`); surface that distinctly so an
// oversized passphrase is not mislabeled as a broken link.
const PASSWORD_LENGTH_MESSAGE = 'Password must be 8-128 characters.';

function ResetPasswordContent() {
  const search = useSearchParams();
  const token = search.get('token');
  const linkError = search.has('error');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({
      newPassword,
      token: token ?? '',
    });
    setPending(false);
    if (error) {
      setError(
        error.code === 'PASSWORD_TOO_SHORT' || error.code === 'PASSWORD_TOO_LONG'
          ? PASSWORD_LENGTH_MESSAGE
          : INVALID_LINK_MESSAGE,
      );
      return;
    }
    setDone(true);
  }

  if (!token || linkError) {
    return (
      <div className="auth-result auth-verification-panel">
        <p className="auth-verification-status">Reset link problem</p>
        <p className="auth-alert auth-alert-error" role="alert">
          {INVALID_LINK_MESSAGE}
        </p>
        <p className="auth-foot">
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-result auth-verification-panel">
        <p className="auth-verification-status">Password updated</p>
        <p className="auth-description">Your password has been reset.</p>
        <p className="auth-alert auth-alert-success" role="status">
          Every signed-in session was signed out. Sign in with your new
          password.
        </p>
        <Link className="auth-primary" href="/login">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="studio-field">
        <span>New password</span>
          <input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          placeholder="At least 8 characters"
        />
      </label>
      <label className="studio-field">
        <span>Confirm password</span>
          <input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          placeholder="Repeat your new password"
        />
      </label>
      <button className="auth-primary" type="submit" disabled={pending}>
        {pending ? 'Resetting…' : 'Reset password'}
      </button>
      {error ? (
        <p className="auth-alert auth-alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <AuthLayout
        image={verificationArtwork}
        imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
        eyebrow="Password reset"
        title="Choose a new password."
        description="Pick something strong. You will sign in again afterwards."
        quote="A clear signal. A private workspace."
      >
        <ResetPasswordContent />
      </AuthLayout>
    </Suspense>
  );
}
