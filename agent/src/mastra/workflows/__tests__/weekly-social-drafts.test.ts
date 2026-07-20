import { describe, expect, it, vi } from 'vitest';

import { buildInstructionsForRole } from '../../../agents/social-media-agent.js';
import type { SendEmailInput } from '../../tools/send-email.js';
import type { Topic } from '../special-days.js';
import {
  buildBrief,
  buildDraftPrompt,
  buildPostUrl,
  renderReviewEmail,
  runWeeklySocialDrafts,
  weeklySocialDrafts,
  weeklySocialDraftsOutputSchema,
  type CreateTextFn,
  type DraftedPost,
} from '../weekly-social-drafts.js';

const FIXED_NOW = new Date('2026-11-23T09:00:00+07:00');

const TOPICS: Topic[] = [
  { kind: 'special-day', name: 'Hari Guru Nasional', angle: 'Apresiasi dan peran guru.', specialDay: 'Hari Guru Nasional' },
  { kind: 'evergreen', name: 'Tips & Trik', angle: 'Edukasi singkat dan praktis.' },
];

describe('pure helpers', () => {
  it('buildPostUrl strips trailing slashes and encodes the post id', () => {
    expect(buildPostUrl('smp_20260713120000_abcd1234', 'http://localhost:3000')).toBe(
      'http://localhost:3000/social-posts/smp_20260713120000_abcd1234',
    );
    expect(buildPostUrl('smp_20260713120000_abcd1234', 'http://localhost:3000/')).toBe(
      'http://localhost:3000/social-posts/smp_20260713120000_abcd1234',
    );
  });

  it('buildDraftPrompt names the topic, platform, week, and the no-preamble rule', () => {
    const prompt = buildDraftPrompt(TOPICS[0]!, '2026-11-23');
    expect(prompt).toContain('Topic: Hari Guru Nasional');
    expect(prompt).toContain('Angle: Apresiasi dan peran guru.');
    expect(prompt).toContain('Instagram');
    expect(prompt).toContain('Week of: 2026-11-23');
    expect(prompt).toContain('no preamble');
  });

  it('buildBrief records the topic, source kind, and special day when present', () => {
    expect(buildBrief(TOPICS[0]!, '2026-11-23')).toContain('Special day: Hari Guru Nasional');
    expect(buildBrief(TOPICS[0]!, '2026-11-23')).toContain('Source: special-day');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).toContain('Source: evergreen-pillar');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).not.toContain('Special day');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).toContain('Platform: instagram');
  });

  it('renderReviewEmail builds subject, linked html, and plain text with both links', () => {
    const posts: DraftedPost[] = [
      { postId: 'smp_a', postUrl: 'http://x/social-posts/smp_a', topic: 'Hari Guru', specialDay: 'Hari Guru', status: 'DRAFT', createdAt: '2026-11-23T02:00:00.000Z' },
      { postId: 'smp_b', postUrl: 'http://x/social-posts/smp_b', topic: 'Tips & Trik', status: 'DRAFT', createdAt: '2026-11-23T02:00:00.000Z' },
    ];
    const email = renderReviewEmail(posts, { weekStart: '2026-11-23' });
    expect(email.subject).toContain('2 Instagram drafts');
    expect(email.subject).toContain('2026-11-23');
    expect(email.html).toContain('href="http://x/social-posts/smp_a"');
    expect(email.html).toContain('href="http://x/social-posts/smp_b"');
    expect(email.text).toContain('http://x/social-posts/smp_a');
    expect(email.text).toContain('http://x/social-posts/smp_b');
  });

  it('renderReviewEmail html-escapes topic labels', () => {
    const posts: DraftedPost[] = [
      { postId: 'smp_a', postUrl: 'http://x/social-posts/smp_a', topic: 'Tips <b> & Co', status: 'DRAFT', createdAt: '2026-11-23T02:00:00.000Z' },
    ];
    const email = renderReviewEmail(posts, { weekStart: '2026-11-23' });
    expect(email.html).toContain('Tips &lt;b&gt; &amp; Co');
  });

  it('buildInstructionsForRole pins the instagram-writer voice (single source of truth)', () => {
    expect(buildInstructionsForRole('instagram-writer')).toContain('Instagram');
    expect(buildInstructionsForRole('instagram-writer')).not.toContain('x-writer');
  });
});

describe('runWeeklySocialDrafts', () => {
  /**
   * The workflow persists via three `create_text_object` MCP calls per post
   * (brief, post, metadata). The fake records every call so tests can assert
   * canonical key layout, write order, and content without touching real
   * storage or the MCP server.
   */
  function buildFakes() {
    const generateCalls: Array<{ prompt: string; instructions: string }> = [];
    const createTextCalls: Array<{ key: string; text: string }> = [];
    let counter = 0;
    const generate = vi.fn(async (prompt: string, instructions: string) => {
      generateCalls.push({ prompt, instructions });
      return `caption-${generateCalls.length}`;
    });
    const createText = vi.fn(async (key: string, text: string): Promise<void> => {
      createTextCalls.push({ key, text });
    });
    const sendEmail = vi.fn(async (_input: SendEmailInput) => ({ success: true, provider: 'resend' as const }));
    return { generate, createText: createText as CreateTextFn, sendEmail, generateCalls, createTextCalls, createTextMock: createText };
  }

  it('drafts, persists via MCP create_text_object, and notifies for 2 topics on the happy path', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000/',
      reviewEmailTo: 'reviewer@example.com',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.emailSent).toBe(true);
    expect(result.posts[0]!.postUrl).toMatch(/^http:\/\/localhost:3000\/social-posts\/smp_/);
    expect(result.posts[1]!.postUrl).toMatch(/^http:\/\/localhost:3000\/social-posts\/smp_/);

    // The drafter reused the pinned Instagram instructions and named each topic.
    expect(fakes.generate).toHaveBeenCalledTimes(2);
    expect(fakes.generateCalls[0]!.instructions).toContain('Instagram');
    expect(fakes.generateCalls[0]!.prompt).toContain('Hari Guru Nasional');

    // Three MCP create_text_object writes per post in canonical order.
    expect(fakes.createText).toHaveBeenCalledTimes(6);
    const firstPostId = result.posts[0]!.postId;
    const firstTriplet = fakes.createTextCalls.slice(0, 3);
    expect(firstTriplet.map((call) => call.key)).toEqual([
      `social-posts/${firstPostId}/brief.md`,
      `social-posts/${firstPostId}/post.md`,
      `social-posts/${firstPostId}/metadata.json`,
    ]);
    expect(firstTriplet[0]!.text).toContain('Week of: 2026-11-23');
    expect(firstTriplet[1]!.text).toBe('caption-1');
    expect(JSON.parse(firstTriplet[2]!.text)).toMatchObject({
      postId: firstPostId,
      platform: 'instagram',
      status: 'DRAFT',
      topic: 'Hari Guru Nasional',
      specialDay: 'Hari Guru Nasional',
    });

    // Second post is an evergreen pillar — no specialDay.
    const secondPostId = result.posts[1]!.postId;
    const secondMetadata = JSON.parse(fakes.createTextCalls[5]!.text);
    expect(secondMetadata).toMatchObject({
      postId: secondPostId,
      topic: 'Tips & Trik',
    });
    expect(secondMetadata.specialDay).toBeUndefined();

    // Email goes to the configured recipient with subject/html/text.
    expect(fakes.sendEmail).toHaveBeenCalledTimes(1);
    expect(fakes.sendEmail.mock.calls[0]![0]).toMatchObject({
      to: 'reviewer@example.com',
      subject: expect.stringContaining('2 Instagram drafts'),
      html: expect.stringContaining(`social-posts/${firstPostId}`),
      text: expect.stringContaining(`social-posts/${firstPostId}`),
    });

    expect(weeklySocialDraftsOutputSchema.safeParse(result).success).toBe(true);
  });

  it('keeps saved drafts and records the error when email delivery fails', async () => {
    const fakes = buildFakes();
    fakes.sendEmail.mockRejectedValueOnce(new Error('RESEND_API_KEY is not set'));
    const result = await runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000',
      reviewEmailTo: 'reviewer@example.com',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.emailSent).toBe(false);
    expect(result.emailError).toContain('RESEND_API_KEY is not set');
    // Drafts were still persisted before the email step ran.
    expect(fakes.createText).toHaveBeenCalledTimes(6);
    expect(weeklySocialDraftsOutputSchema.safeParse(result).success).toBe(true);
  });

  it('skips the email step and records a clear error when recipient is unset', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000',
      reviewEmailTo: '', // simulates SOCIAL_DRAFT_REVIEW_EMAIL being unset
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    // Drafts are still saved before the email step is evaluated.
    expect(fakes.createText).toHaveBeenCalledTimes(6);
    // Email was skipped — Resend was never called.
    expect(fakes.sendEmail).not.toHaveBeenCalled();
    expect(result.emailSent).toBe(false);
    expect(result.emailError).toContain('SOCIAL_DRAFT_REVIEW_EMAIL is not set');
    expect(weeklySocialDraftsOutputSchema.safeParse(result).success).toBe(true);
  });

  it('wires the default topic selector through (1 special + 1 evergreen for Independence week)', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      // No selectTopics override: uses real selectTopicsForWeek.
      now: () => new Date('2026-08-17T09:00:00+07:00'),
      webUrl: 'http://localhost:3000',
      reviewEmailTo: 'reviewer@example.com',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(fakes.createText).toHaveBeenCalledTimes(6);
    const metadataTexts = fakes.createTextCalls
      .filter((call) => call.key.endsWith('/metadata.json'))
      .map((call) => JSON.parse(call.text));
    const specialDay = metadataTexts.find((entry) => entry.specialDay !== undefined);
    const evergreen = metadataTexts.find((entry) => entry.specialDay === undefined);
    expect(specialDay?.specialDay).toBe('Hari Kemerdekaan Republik Indonesia');
    expect(evergreen).toBeDefined();
  });

  it('propagates a partial-write failure from create_text_object without writing metadata', async () => {
    const fakes = buildFakes();
    // The first call (brief.md) succeeds and records; the second call
    // (post.md) fails before metadata.json is written.
    fakes.createTextMock.mockImplementationOnce(async (key: string, text: string) => {
      fakes.createTextCalls.push({ key, text });
    });
    fakes.createTextMock.mockImplementationOnce(async () => {
      throw new Error('Garage MCP: create_text_object failed');
    });

    await expect(runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000',
      reviewEmailTo: 'reviewer@example.com',
      generate: fakes.generate,
      createText: fakes.createText,
      sendEmail: fakes.sendEmail,
    })).rejects.toThrow('Garage MCP: create_text_object failed');

    // Only brief.md of post #1 was attempted before the failure; post.md
    // threw, so metadata.json was never written and the listing will skip
    // this partial save.
    expect(fakes.createTextMock.mock.calls).toHaveLength(2);
    expect((fakes.createTextMock.mock.calls[0]![0] as string)).toMatch(/\/brief\.md$/);
    expect((fakes.createTextMock.mock.calls[1]![0] as string)).toMatch(/\/post\.md$/);
    expect(fakes.createTextMock.mock.calls.some((call) => (call[0] as string).endsWith('/metadata.json'))).toBe(false);
  });
});

describe('weeklySocialDrafts workflow', () => {
  it('has id weekly-social-drafts and constructs with a weekly schedule', () => {
    expect(weeklySocialDrafts.id).toBe('weekly-social-drafts');
    expect(weeklySocialDrafts).toBeDefined();
  });
});
