'use client';

import Link from 'next/link';
import { useState } from 'react';
import signupArtwork from '@/assets/auth/signup-low-poly.png';
import verificationArtwork from '@/assets/auth/verification-low-poly.png';
import { AuthLayout } from '@/components/auth/auth-layout';
import { authClient } from '@/lib/auth-client';
import { EMAIL_VERIFICATION_CALLBACK_URL } from '@/lib/auth-redirects';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      email,
      password,
      name,
      callbackURL: EMAIL_VERIFICATION_CALLBACK_URL,
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
      <AuthLayout
        image={verificationArtwork}
        imageAlt="Low-poly coastal beacon sending a warm signal at dawn"
        eyebrow="Almost there"
        title="Check your email."
        description="Your private agent studio is one quick verification away."
        quote="A clear signal. A private workspace."
      >
        <div className="auth-result auth-verification-panel">
          <p className="auth-verification-status">Verification email sent</p>
          <p className="auth-description">
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
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      image={signupArtwork}
      imageAlt="Low-poly terraced garden rising toward a bright horizon"
      eyebrow="Create your account"
      title="Start with a clear workspace."
      description="Bring your agents, tools, and conversations together in one private studio."
      quote="Build a studio that thinks with you."
    >
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
          <label className="studio-field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
              placeholder="Repeat your password"
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
    </AuthLayout>
  );
}
