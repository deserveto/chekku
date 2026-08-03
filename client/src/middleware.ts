import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { consumeRateLimit, resolveAuthRedirect } from '@/server/auth-rate-limit';

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? '127.0.0.1';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (request.method === 'POST') {
    if (pathname.endsWith('/sign-up/email')) {
      const result = consumeRateLimit('signup', clientIp(request));
      if (!result.allowed) {
        return new NextResponse('Too many requests.', {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
          },
        });
      }
    }
    if (pathname.endsWith('/send-verification-email')) {
      const result = consumeRateLimit('resend', clientIp(request));
      if (!result.allowed) {
        return new NextResponse('Too many requests.', {
          status: 429,
          headers: {
            'retry-after': String(Math.ceil(result.retryAfterMs / 1000)),
          },
        });
      }
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
