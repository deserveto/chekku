import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Email Outbound Tool (Resend)
 *
 * Sends email from inside an agent through the Resend HTTP API. Resend exposes
 * the same capabilities as SMTP without a local mail transport, and is the
 * provider's recommended integration path. The API key is read from
 * `RESEND_API_KEY`; the default sender from `RESEND_FROM_EMAIL`.
 *
 * Registered through `storedAgentTools` so stored agents (e.g. a PM agent that
 * delivers a weekly-report analysis) can dispatch email without holding a key.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const defaultFrom = () =>
  process.env.RESEND_FROM_EMAIL?.trim() || 'Chekku <onboarding@resend.dev>';

const emailInputSchema = z.object({
  to: z
    .union([z.string().email(), z.array(z.string().email()).min(1)])
    .describe('Recipient email address, or an array of addresses.'),
  subject: z.string().min(1).max(200),
  html: z.string().describe('HTML body of the email.'),
  text: z
    .string()
    .optional()
    .describe('Optional plain-text fallback for clients that disable HTML.'),
  cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  replyTo: z.string().email().optional(),
  from: z
    .string()
    .max(200)
    .optional()
    .describe('Override the sender. Must use a Resend-verified domain.'),
});

export type SendEmailInput = z.infer<typeof emailInputSchema>;

interface ResendSuccess {
  id?: string;
  message?: string;
}

interface ResendError {
  message?: string;
  name?: string;
}

type ResendPayload = ResendSuccess & ResendError;

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Build the JSON body that Resend's `/emails` endpoint expects. Performs no
 * network I/O, but is not pure: when `from` is omitted it falls back to the
 * `RESEND_FROM_EMAIL` env var via `defaultFrom()`. Pass `from` explicitly for
 * deterministic output.
 */
export function buildResendEmailBody(input: SendEmailInput): Record<string, unknown> {
  const { to, subject, html, text, cc, bcc, replyTo, from } = input;
  return {
    from: from?.trim() || defaultFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text ? { text } : {}),
    ...(cc ? { cc: toArray(cc) } : {}),
    ...(bcc ? { bcc: toArray(bcc) } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  provider: 'resend';
}

/**
 * Deliver email through Resend. Reads the API key from `RESEND_API_KEY`.
 * Throws a clear, actionable error when the key is missing or the request
 * fails; never surfaces raw credentials.
 */
export async function sendEmailViaResend(
  input: SendEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'send-email: RESEND_API_KEY is not set. Add it to agent/.env before sending.',
    );
  }

  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildResendEmailBody(input)),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as ResendPayload;

  if (!response.ok) {
    throw new Error(
      `Resend API returned ${response.status}: ${payload.message ?? payload.name ?? 'unknown error'}`,
    );
  }

  return {
    success: true,
    ...(payload.id ? { messageId: payload.id } : {}),
    provider: 'resend',
  };
}

export const sendEmailTool = createTool({
  id: 'send-email',
  description:
    'Send a transactional email via Resend. Use this to deliver an agent-produced artifact (e.g. a weekly-report analysis) to a recipient inbox. Requires RESEND_API_KEY. The sender ("from") must be a Resend-verified domain; the default onboarding sender can only deliver to the account owner.',
  inputSchema: emailInputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
    provider: z.literal('resend'),
  }),
  requireApproval: true,
  execute: async (input) => sendEmailViaResend(input),
});
