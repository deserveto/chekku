import 'server-only';

interface SendVerificationEmailArgs {
  to: string;
  url: string;
}

export async function sendVerificationEmail({
  to,
  url,
}: SendVerificationEmailArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[auth] verification email (dev console fallback): ${url}`);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    console.log(`[auth] verification email (RESEND_FROM_EMAIL unset): ${url}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Verify your Chekku email',
      html: `<p>Verify your email by clicking <a href="${url}">this link</a>.</p><p>${url}</p>`,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to send verification email.');
  }
}
