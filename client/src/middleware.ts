import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { consumeRateLimit, resolveAuthRedirect } from '@/server/auth-rate-limit';

export type AuthThrottleScope = 'signup' | 'signin' | 'resend' | 'password-reset';

const THROTTLED_AUTH_ENDPOINTS: Array<{
  suffix: string;
  scope: AuthThrottleScope;
}> = [
  { suffix: '/sign-up/email', scope: 'signup' },
  { suffix: '/sign-in/email', scope: 'signin' },
  { suffix: '/send-verification-email', scope: 'resend' },
  { suffix: '/request-password-reset', scope: 'password-reset' },
];

/**
 * Pure mapping from an incoming request to its auth throttle scope. Better
 * Auth endpoints are matched by path suffix because the auth handler is
 * mounted at `/api/auth/[...all]`, so `pathname` is the full request path.
 */
export function resolveAuthThrottleScope(
  method: string,
  pathname: string,
): AuthThrottleScope | null {
  if (method !== 'POST') return null;
  return (
    THROTTLED_AUTH_ENDPOINTS.find((entry) => pathname.endsWith(entry.suffix))
      ?.scope ?? null
  );
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? '127.0.0.1';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const scope = resolveAuthThrottleScope(request.method, pathname);
  if (scope) {
    const result = consumeRateLimit(scope, clientIp(request));
    if (!result.allowed) {
      return new NextResponse('Too many requests.', {
        status: 429,
        headers: {
          'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
        },
      });
    }
  }

  const target = resolveAuthRedirect({
    pathname,
    hasSession: Boolean(getSessionCookie(request)),
  });
  if (target) {
    return NextResponse.redirect(new URL(target, request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)',
  ],
};
