// Where Better Auth sends the browser once a verification link is consumed.
// The login page reads `verified=1` — plus the `error` code Better Auth appends
// on failure — to render the outcome banner.
export const EMAIL_VERIFICATION_CALLBACK_URL = '/login?verified=1';

// Pin the `callbackURL` of a Better Auth verification link.
//
// Better Auth builds the link from whatever `callbackURL` the caller supplied
// and falls back to `/` when there is none. The resend triggered by an
// unverified user attempting to sign in (`emailVerification.sendOnSignIn`) has
// no way to supply one: passing `callbackURL` to `signIn.email` also makes a
// *successful* sign-in redirect the browser to that URL. Rewriting the link
// server-side covers every trigger — signup, manual resend, sign-in resend —
// with a single rule. Without it, the sign-in resend verifies and lands on `/`,
// which is not public, so the middleware bounces the still-signed-out user to a
// bare `/login` with `verified=1`/`error` stripped and no banner shown.
export function withEmailVerificationCallback(url: string): string {
  try {
    const link = new URL(url);
    link.searchParams.set('callbackURL', EMAIL_VERIFICATION_CALLBACK_URL);
    return link.toString();
  } catch {
    // Not an absolute URL, so there is nothing safe to rewrite. Deliver the
    // link as-is rather than dropping the verification mail.
    return url;
  }
}
