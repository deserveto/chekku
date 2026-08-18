import { describe, expect, it } from 'vitest';
import { resolveAuthThrottleScope } from './middleware';

describe('resolveAuthThrottleScope', () => {
  it('maps each throttled Better Auth endpoint to its scope', () => {
    expect(
      resolveAuthThrottleScope('POST', '/api/auth/sign-up/email'),
    ).toBe('signup');
    expect(
      resolveAuthThrottleScope('POST', '/api/auth/sign-in/email'),
    ).toBe('signin');
    expect(
      resolveAuthThrottleScope('POST', '/api/auth/send-verification-email'),
    ).toBe('resend');
    expect(
      resolveAuthThrottleScope('POST', '/api/auth/request-password-reset'),
    ).toBe('password-reset');
  });

  it('leaves every other auth request unthrottled', () => {
    expect(resolveAuthThrottleScope('GET', '/api/auth/request-password-reset')).toBeNull();
    expect(resolveAuthThrottleScope('POST', '/api/auth/reset-password')).toBeNull();
    expect(resolveAuthThrottleScope('POST', '/api/auth/sign-out')).toBeNull();
    expect(resolveAuthThrottleScope('POST', '/api/storage/pm-reports')).toBeNull();
  });
});
