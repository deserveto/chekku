import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildResendEmailBody,
  sendEmailTool,
  sendEmailViaResend,
} from './send-email.js';

describe('sendEmailTool', () => {
  it('runs external delivery without requiring approval', () => {
    expect(sendEmailTool.requireApproval).not.toBe(true);
  });
});

describe('buildResendEmailBody', () => {
  beforeEach(() => {
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('shapes a minimal payload and falls back to the default sender', () => {
    const body = buildResendEmailBody({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(body).toEqual({
      from: 'Chekku <onboarding@resend.dev>',
      to: ['user@example.com'],
      subject: 'Hello',
      html: '<p>Hi</p>',
    });
  });

  it('uses RESEND_FROM_EMAIL when set and unwraps single recipients', () => {
    process.env.RESEND_FROM_EMAIL = 'Chekku <noreply@chekku.dev>';
    const body = buildResendEmailBody({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(body.from).toBe('Chekku <noreply@chekku.dev>');
    expect(body.to).toEqual(['user@example.com']);
  });

  it('preserves cc/bcc/reply_to/text when provided', () => {
    const body = buildResendEmailBody({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
      cc: 'cc@example.com',
      bcc: ['bcc1@example.com', 'bcc2@example.com'],
      replyTo: 'reply@example.com',
      from: 'Custom <custom@chekku.dev>',
    });

    expect(body).toMatchObject({
      to: ['a@example.com', 'b@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc1@example.com', 'bcc2@example.com'],
      reply_to: 'reply@example.com',
      text: 'Hi',
      from: 'Custom <custom@chekku.dev>',
    });
  });
});

describe('sendEmailViaResend', () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it('throws a clear error when RESEND_API_KEY is missing', async () => {
    await expect(
      sendEmailViaResend({ to: 'x@example.com', subject: 's', html: '<p></p>' }),
    ).rejects.toThrow('RESEND_API_KEY is not set');
  });

  it('posts to Resend and returns the message id on success', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }),
    );

    const result = await sendEmailViaResend(
      { to: 'x@example.com', subject: 's', html: '<p></p>' },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      success: true,
      messageId: 'msg_123',
      provider: 'resend',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init as RequestInit).method).toBe('POST');
    const authHeader = (init as RequestInit).headers as Record<string, string>;
    expect(authHeader.Authorization).toBe('Bearer test-key');
  });

  it('surfaces Resend error messages without leaking the key', async () => {
    process.env.RESEND_API_KEY = 'secret-key';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: 'Invalid API key' }),
        { status: 401 },
      ),
    );

    await expect(
      sendEmailViaResend(
        { to: 'x@example.com', subject: 's', html: '<p></p>' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Resend API returned 401: Invalid API key');
  });
});
