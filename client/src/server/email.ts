import 'server-only';

interface SendAuthMailArgs {
  to: string;
  url: string;
}

export async function sendVerificationEmail({
  to,
  url,
}: SendAuthMailArgs): Promise<void> {
  await deliverAuthEmail({
    to,
    subject: 'Verify your Chekku email',
    html: `<p>Verify your email by clicking <a href="${url}">this link</a>.</p><p>${url}</p>`,
    consoleFallbackLine: `[auth] verification email (dev console fallback): ${url}`,
    failureMessage: 'Failed to send verification email.',
  });
}

export async function sendResetPasswordEmail({
  to,
  url,
}: SendAuthMailArgs): Promise<void> {
  await deliverAuthEmail({
    to,
    subject: 'Reset your Chekku password',
    html: `<p>Reset your password by clicking <a href="${url}">this link</a>. The link expires in one hour and works once.</p><p>${url}</p>`,
    consoleFallbackLine: `[auth] reset password email (dev console fallback): ${url}`,
    failureMessage: 'Failed to send reset password email.',
  });
}

async function deliverAuthEmail({
  to,
  subject,
  html,
  consoleFallbackLine,
  failureMessage,
}: {
  to: string;
  subject: string;
  html: string;
  consoleFallbackLine: string;
  failureMessage: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(consoleFallbackLine);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error(failureMessage);
  }

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch {
    throw new Error(failureMessage);
  }

  if (!response.ok) {
    cancelBody(response.body);
    throw new Error(failureMessage);
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the fixed client error.
  }
}
