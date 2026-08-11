import { describe, expect, it } from 'vitest';
import {
  EMAIL_VERIFICATION_CALLBACK_URL,
  withEmailVerificationCallback,
} from './auth-redirects';

describe('withEmailVerificationCallback', () => {
  it('replaces the default root callback Better Auth falls back to', () => {
    const url = withEmailVerificationCallback(
      'https://app.test/api/auth/verify-email?token=abc&callbackURL=%2F',
    );

    expect(new URL(url).searchParams.get('callbackURL')).toBe(
      EMAIL_VERIFICATION_CALLBACK_URL,
    );
    expect(new URL(url).searchParams.get('token')).toBe('abc');
  });

  it('adds the callback when the link carries none', () => {
    const url = withEmailVerificationCallback(
      'https://app.test/api/auth/verify-email?token=abc',
    );

    expect(new URL(url).searchParams.get('callbackURL')).toBe(
      EMAIL_VERIFICATION_CALLBACK_URL,
    );
  });

  it('leaves a link it cannot parse untouched rather than dropping the mail', () => {
    expect(withEmailVerificationCallback('not a url')).toBe('not a url');
  });
});
