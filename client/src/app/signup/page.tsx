'use client';

import Link from 'next/link';
import { useState } from 'react';
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
      <main>
        <h1>Check your email</h1>
        <p>
          We sent a verification link to <strong>{email}</strong>. Click it to
          verify your account, then sign in.
        </p>
        <p>
          <Link href="/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your Chekku account</h1>
      <form onSubmit={onSubmit}>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoComplete="name"
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="new-password"
            minLength={8}
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Sign up'}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      <p>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
