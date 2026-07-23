import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildInstructionsForRole } from '../../../agents/social-media-agent.js';
import type { SearxngSearchOutput, SearxngSearchResult } from '../../searxng/client.js';
import type { SendEmailInput } from '../../tools/send-email.js';
import type { Topic } from '../special-days.js';
import {
  buildBrief,
  buildDraftPrompt,
  buildPostUrl,
  buildSourceBlock,
  buildTitleHint,
  renderReviewEmail,
  runWeeklySocialDrafts,
  weeklySocialDrafts,
  weeklySocialDraftsOutputSchema,
  type CreateTextFn,
  type DraftedPost,
} from '../weekly-social-drafts.js';
import type { SearchFn } from '../trending-research.js';

// `env` is loaded once at module import, so direct `process.env` mutation in
// tests would not affect the frozen `env` object the workflow reads. We mock
// the module and expose a mutable surface so individual tests can flip the
// configured recipient / SearXNG base URL.
const envMock = vi.hoisted(() => ({
  SOCIAL_DRAFT_REVIEW_EMAIL: 'reviewer@example.com',
  WEB_URL: 'http://localhost:3000',
  SEARXNG_BASE_URL: '',
  PUBLIC_HOLIDAY_API_BASE_URL: '',
  PUBLIC_HOLIDAY_CACHE_DIR: '',
}));

vi.mock('../../../config/env.js', () => ({ env: envMock }));

const FIXED_NOW = new Date('2026-11-23T09:00:00+07:00');

const TOPICS: Topic[] = [
  { kind: 'special-day', name: 'Hari Guru Nasional', angle: 'Apresiasi dan peran guru.', specialDay: 'Hari Guru Nasional' },
  { kind: 'evergreen', name: 'Tips & Trik', angle: 'Edukasi singkat dan praktis.' },
];

const TRENDING_TOPIC: Topic = {
  kind: 'trending',
  name: 'AI tools ramai dibahas',
  angle: 'Sejumlah AI tool baru dirilis pekan ini.',
  source: {
    url: 'https://example.com/article',
    title: 'AI tools ramai dibahas',
    snippet: 'Sejumlah AI tool baru dirilis pekan ini.',
  },
};

function makeSearchResult(overrides: Partial<SearxngSearchResult> = {}): SearxngSearchResult {
  return {
    url: 'https://example.com/article',
    title: 'AI tools ramai dibahas',
    snippet: 'Sejumlah AI tool baru dirilis pekan ini.',
    engines: ['google'],
    ...overrides,
  };
}

function makeSearchOutput(results: SearxngSearchResult[]): SearxngSearchOutput {
  return {
    query: 'q',
    page: 1,
    results,
    answers: [],
    corrections: [],
    suggestions: [],
    truncated: false,
  };
}

describe('pure helpers', () => {
  it('buildPostUrl strips trailing slashes and encodes the post id', () => {
    expect(buildPostUrl('smp_20260713120000_abcd1234', 'http://localhost:3000')).toBe(
      'http://localhost:3000/social-posts/smp_20260713120000_abcd1234',
    );
    expect(buildPostUrl('smp_20260713120000_abcd1234', 'http://localhost:3000/')).toBe(
      'http://localhost:3000/social-posts/smp_20260713120000_abcd1234',
    );
  });

  it('buildDraftPrompt names the topic, week, and the no-preamble rule for greeting-card copy', () => {
    const prompt = buildDraftPrompt(TOPICS[0]!, '2026-11-23');
    expect(prompt).toContain('Topic: Hari Guru Nasional');
    expect(prompt).toContain('Angle: Apresiasi dan peran guru.');
    expect(prompt).toContain('Week of: 2026-11-23');
    expect(prompt).toContain('greeting-card');
    expect(prompt).toContain('no preamble');
    // Required brand identity surfaces in the output template.
    expect(prompt).toContain('R — Your Gentle AI Companion');
    expect(prompt).toContain('AI Human-Centered Intelligence');
    expect(prompt).toContain('Hormat kami,');
    expect(prompt).toContain('Keluarga Besar PT Rafiq Space Intelligence');
  });

  it('buildDraftPrompt pins the "Selamat {day}" title template for awareness days', () => {
    const prompt = buildDraftPrompt(TOPICS[0]!, '2026-11-23');
    expect(prompt).toContain('Selamat Hari Guru Nasional');
    expect(prompt).toContain('Poin-poin');
    // Date line gets its own template slot between title and opening, with
    // separate rules for Hijri vs Gregorian vs omit for trending/evergreen.
    expect(prompt).toContain('canonical date or year line');
    expect(prompt).toMatch(/Date\/year line[\s\S]*Hijri form[\s\S]*Gregorian/i);
    // Poin-poin must use the explicit **[Brand value]:** <elaboration> format.
    expect(prompt).toContain('**[Brand value');
    expect(prompt).toContain('Human-Centered');
    expect(prompt).toContain('Memanfaatkan teknologi sebagai alat bantu belajar');
    // Caption-style requirements are gone: no mandatory hashtag set, no
    // mandatory "Visual:" direction line. The prompt explicitly forbids both
    // for the greeting-card format, so the literal strings appear only inside
    // a "do not include" rule — not as positive requirements.
    expect(prompt).not.toMatch(/^[^-].*\bhashtag set\b/m);
    expect(prompt).toContain('no caption-style hashtags');
    expect(prompt).toContain('no "Visual:" line');
  });

  it('buildDraftPrompt injects reference URL and snippet for trending topics', () => {
    const prompt = buildDraftPrompt(TRENDING_TOPIC, '2026-11-23');
    expect(prompt).toContain('trending topic from this week\'s web search');
    expect(prompt).toContain('Reference URL: https://example.com/article');
    expect(prompt).toContain('Reference snippet: Sejumlah AI tool baru dirilis pekan ini.');
    // Trending title template.
    expect(prompt).toContain('Tren Minggu Ini: AI tools ramai dibahas');
  });

  it('buildSourceBlock keeps evergreen and special-day copy stable', () => {
    expect(buildSourceBlock(TOPICS[0]!)).toContain('scheduled awareness day — Hari Guru Nasional');
    expect(buildSourceBlock(TOPICS[1]!)).toContain('evergreen content pillar — Tips & Trik');
  });

  it('buildTitleHint returns the awareness-day, trending, and evergreen templates', () => {
    expect(buildTitleHint(TOPICS[0]!).template).toBe('Selamat Hari Guru Nasional');
    expect(buildTitleHint(TRENDING_TOPIC).template).toBe('Tren Minggu Ini: AI tools ramai dibahas');
    expect(buildTitleHint(TOPICS[1]!).template).toBe('Tips & Trik');
  });

  it('buildBrief records the topic, source kind, and special day when present', () => {
    expect(buildBrief(TOPICS[0]!, '2026-11-23')).toContain('Special day: Hari Guru Nasional');
    expect(buildBrief(TOPICS[0]!, '2026-11-23')).toContain('Source: special-day');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).toContain('Source: evergreen-pillar');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).not.toContain('Special day');
    expect(buildBrief(TOPICS[1]!, '2026-11-23')).toContain('Platform: instagram');
  });

  it('buildBrief records research context for trending topics', () => {
    const brief = buildBrief(TRENDING_TOPIC, '2026-11-23');
    expect(brief).toContain('Source: trending-research');
    expect(brief).toContain('Reference URL: https://example.com/article');
    expect(brief).not.toContain('Special day');
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

  beforeEach(() => {
    envMock.SOCIAL_DRAFT_REVIEW_EMAIL = 'reviewer@example.com';
    envMock.WEB_URL = 'http://localhost:3000';
    envMock.SEARXNG_BASE_URL = '';
    envMock.PUBLIC_HOLIDAY_API_BASE_URL = '';
    envMock.PUBLIC_HOLIDAY_CACHE_DIR = '';
  });

  it('drafts, persists via MCP create_text_object, and notifies for 2 topics on the happy path', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000/',
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
    envMock.SOCIAL_DRAFT_REVIEW_EMAIL = ''; // simulates env var being unset
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      now: () => FIXED_NOW,
      selectTopics: () => TOPICS,
      webUrl: 'http://localhost:3000',
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

  it('falls back to 2 evergreen pillars with no awareness bonus when SearXNG is not wired (Independence week)', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      // No `selectTopics` override → Stage 2 path.
      // No `search` override → createDefaultSearch() returns undefined in
      // the test environment (SEARXNG_BASE_URL is empty), so the workflow
      // switches to degraded mode: 2 evergreen pillars, no awareness bonus,
      // even though 2026-08-17 is Independence Day.
      now: () => new Date('2026-08-17T09:00:00+07:00'),
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.posts.every((post) => post.specialDay === undefined)).toBe(true);
    expect(result.researchNote).toContain('SearXNG is not configured');
    expect(fakes.createText).toHaveBeenCalledTimes(6);
    expect(weeklySocialDraftsOutputSchema.safeParse(result).success).toBe(true);
  });

  it('drafts 2 trending posts + 1 awareness bonus when research succeeds on a week with a holiday', async () => {
    const fakes = buildFakes();
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeSearchOutput([
        makeSearchResult({ url: 'https://a.example/trend-1', title: 'Trend Satu', snippet: 'Snip satu.' }),
        makeSearchResult({ url: 'https://b.example/trend-2', title: 'Trend Dua', snippet: 'Snip dua.' }),
      ]),
    );

    const result = await runWeeklySocialDrafts({
      now: () => new Date('2026-08-17T09:00:00+07:00'),
      search: search as SearchFn,
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(3);
    // Two trending base slots + Independence Day bonus at the tail.
    const topics = result.posts.map((post) => post.topic);
    expect(topics).toEqual(['Trend Satu', 'Trend Dua', 'Hari Kemerdekaan Republik Indonesia']);
    expect(result.posts[2]!.specialDay).toBe('Hari Kemerdekaan Republik Indonesia');
    expect(result.researchNote).toBeUndefined();
    expect(fakes.generate).toHaveBeenCalledTimes(3);
    expect(fakes.createText).toHaveBeenCalledTimes(9); // 3 writes per post
    expect(fakes.sendEmail.mock.calls[0]![0]).toMatchObject({
      subject: expect.stringContaining('3 Instagram drafts'),
    });
    // Trending briefs record the reference URL.
    const firstBrief = fakes.createTextCalls.find((call) => call.key.endsWith('/brief.md'))!;
    expect(firstBrief.text).toContain('Reference URL: https://a.example/trend-1');
  });

  it('drafts 2 trending posts and no bonus when the week has no awareness day', async () => {
    const fakes = buildFakes();
    // 2026-07-13 week has no awareness day in SPECIAL_DAYS.
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeSearchOutput([
        makeSearchResult({ url: 'https://a.example/trend-1', title: 'Trend Satu', snippet: 'Snip satu.' }),
        makeSearchResult({ url: 'https://b.example/trend-2', title: 'Trend Dua', snippet: 'Snip dua.' }),
      ]),
    );

    const result = await runWeeklySocialDrafts({
      now: () => new Date('2026-07-15T09:00:00+07:00'),
      search: search as SearchFn,
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.posts.every((post) => post.specialDay === undefined)).toBe(true);
  });

  it('fills the 2 base slots with evergreen pillars when research returns fewer than 2', async () => {
    const fakes = buildFakes();
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeSearchOutput([
        makeSearchResult({ url: 'https://a.example/only', title: 'Hanya Satu Trend', snippet: 'Snip.' }),
      ]),
    );

    const result = await runWeeklySocialDrafts({
      now: () => new Date('2026-07-15T09:00:00+07:00'),
      search: search as SearchFn,
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0]!.topic).toBe('Hanya Satu Trend');
    // Second slot is an evergreen pillar, no specialDay.
    expect(result.posts[1]!.specialDay).toBeUndefined();
  });

  it('records a researchNote and skips the bonus when research fails even on a holiday week', async () => {
    const fakes = buildFakes();
    const search = vi.fn(async (): Promise<SearxngSearchOutput> => {
      throw new Error('SearXNG search is unavailable.');
    });

    const result = await runWeeklySocialDrafts({
      // Independence week — would normally get an awareness-day bonus.
      // When research totally fails, the workflow degrades to 2 evergreen
      // pillars with no bonus, matching the "SearXNG unavailable" contract.
      now: () => new Date('2026-08-17T09:00:00+07:00'),
      search: search as SearchFn,
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.posts.every((post) => post.specialDay === undefined)).toBe(true);
    expect(result.researchNote).toContain('SearXNG research failed');
  });

  it('skips awareness-day bonus when search is undefined, even if the week has a holiday', async () => {
    const fakes = buildFakes();
    const result = await runWeeklySocialDrafts({
      now: () => new Date('2026-08-17T09:00:00+07:00'),
      search: undefined, // explicitly no search seam
      webUrl: 'http://localhost:3000',
      ...fakes,
    });

    expect(result.ok).toBe(true);
    expect(result.posts).toHaveLength(2);
    expect(result.posts.every((post) => post.specialDay === undefined)).toBe(true);
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
