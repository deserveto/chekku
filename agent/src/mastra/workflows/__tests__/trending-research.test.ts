import { describe, expect, it, vi } from 'vitest';

import type { SearxngSearchOutput, SearxngSearchResult } from '../../searxng/client.js';
import {
  BLOCKED_HOST_PATTERNS,
  DEFAULT_TRENDING_QUERIES,
  MAX_TRENDING_TOPICS,
  awarenessTokens,
  isBlockedHost,
  overlapsAwarenessDay,
  researchTrendingTopics,
  type SearchFn,
} from '../trending-research.js';

function makeResult(overrides: Partial<SearxngSearchResult> = {}): SearxngSearchResult {
  return {
    url: 'https://example.com/article',
    title: 'Article title',
    snippet: 'Article snippet with context.',
    engines: ['google'],
    ...overrides,
  };
}

function makeOutput(results: SearxngSearchResult[], query = 'q'): SearxngSearchOutput {
  return {
    query,
    page: 1,
    results,
    answers: [],
    corrections: [],
    suggestions: [],
    truncated: false,
  };
}

describe('researchTrendingTopics', () => {
  it('maps up to 2 distinct results into trending topics', async () => {
    const search = vi.fn(async (_query: string): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://a.example/1', title: 'Trending One', snippet: 'Snip one.' }),
        makeResult({ url: 'https://a.example/2', title: 'Trending Two', snippet: 'Snip two.' }),
        makeResult({ url: 'https://a.example/3', title: 'Trending Three', snippet: 'Snip three.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(2);
    expect(topics.every((topic) => topic.kind === 'trending')).toBe(true);
    expect(topics[0]!.name).toBe('Trending One');
    expect(topics[0]!.source?.url).toBe('https://a.example/1');
    expect(topics[1]!.name).toBe('Trending Two');
  });

  it('uses the default queries and diversifies one topic per query', async () => {
    const search = vi.fn(async (_query: string): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://a.example/1', title: 'A', snippet: 'Snip.' }),
        makeResult({ url: 'https://a.example/2', title: 'B', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    // With diversify, each query contributes at most one topic. Two topics
    // means two queries were issued (not one query returning two topics).
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]![0]).toBe(DEFAULT_TRENDING_QUERIES[0]);
    expect(search.mock.calls[1]![0]).toBe(DEFAULT_TRENDING_QUERIES[1]);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://a.example/1',
      'https://a.example/2',
    ]);
  });

  it('skips social-media hosts (TikTok, Instagram, YouTube, etc.)', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://tiktok.com/@user/video/123', title: 'Trend TikTok', snippet: 'Viral.' }),
        makeResult({ url: 'https://www.instagram.com/reel/abc', title: 'IG Reel', snippet: 'Viral.' }),
        makeResult({ url: 'https://m.youtube.com/shorts/xyz', title: 'YT Short', snippet: 'Viral.' }),
        makeResult({ url: 'https://news.example/real-article', title: 'Real News', snippet: 'Actual reporting.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://news.example/real-article');
  });

  it('continues to the next query when the first returns fewer than maxTopics', async () => {
    const search = vi.fn(async (query: string): Promise<SearxngSearchOutput> => {
      if (query === DEFAULT_TRENDING_QUERIES[0]) {
        return makeOutput([makeResult({ url: 'https://a.example/1', title: 'Only One', snippet: 'Snip.' })]);
      }
      return makeOutput([makeResult({ url: 'https://b.example/2', title: 'Second Query Result', snippet: 'Snip.' })]);
    });

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(search).toHaveBeenCalledTimes(2);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
  });

  it('dedupes the same URL across queries', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://dup.example/same', title: 'Same', snippet: 'Snip.' }),
        makeResult({ url: 'https://dup.example/other', title: 'Other', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(2);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://dup.example/same',
      'https://dup.example/other',
    ]);
  });

  it('skips results without a usable title or snippet', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://a.example/no-title', title: '   ', snippet: 'Snip.' }),
        makeResult({ url: 'https://a.example/no-snip', title: 'Title', snippet: '' }),
        makeResult({ url: 'https://a.example/ok', title: 'Real Title', snippet: 'Real snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://a.example/ok');
  });

  it('throws when every query fails so the caller can mark the pass as degraded', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> => {
      throw new Error('SearXNG search is not configured.');
    });

    await expect(researchTrendingTopics(search as SearchFn)).rejects.toThrow(
      'Every SearXNG query failed during trending research.',
    );
    // Tried every default query before giving up.
    expect(search).toHaveBeenCalledTimes(DEFAULT_TRENDING_QUERIES.length);
  });

  it('continues to the next query when one query throws mid-pass', async () => {
    let call = 0;
    const search = vi.fn(async (): Promise<SearxngSearchOutput> => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return makeOutput([makeResult({ url: 'https://a.example/2', title: 'Recovered', snippet: 'Snip.' })]);
    });

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.name).toBe('Recovered');
  });

  it('skips trending results that overlap the awareness day name tokens', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({
          url: 'https://a.example/related',
          title: 'Pers sempat viral hari ini',
          snippet: 'Berita tentang pers nasional minggu ini.',
        }),
        makeResult({
          url: 'https://a.example/unrelated',
          title: 'Tips hemat energi',
          snippet: 'Cara menghemat listrik.',
        }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, {
      excludeAwarenessDay: 'Hari Pers Nasional',
    });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://a.example/unrelated');
  });

  it('respects an explicit maxTopics override', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://a.example/1', title: 'A', snippet: 'Snip.' }),
        makeResult({ url: 'https://a.example/2', title: 'B', snippet: 'Snip.' }),
        makeResult({ url: 'https://a.example/3', title: 'C', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
  });

  it('default max matches the 2-slot contract', () => {
    expect(MAX_TRENDING_TOPICS).toBe(2);
  });

  it('truncates very long titles and snippets in the topic name/angle', async () => {
    const longTitle = 'A'.repeat(500);
    const longSnippet = 'B'.repeat(1000);
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://a.example/long', title: longTitle, snippet: longSnippet }),
      ]),
    );

    const [topic] = await researchTrendingTopics(search as SearchFn);

    expect(topic).toBeDefined();
    expect(topic!.name.length).toBeLessThanOrEqual(200);
    expect(topic!.angle.length).toBeLessThanOrEqual(400);
    // Original lengths preserved inside source for the prompt.
    expect(topic!.source?.title.length).toBe(500);
    expect(topic!.source?.snippet.length).toBe(1000);
  });
});

describe('isBlockedHost', () => {
  it('returns true for bare social-media domains', () => {
    expect(isBlockedHost('https://tiktok.com/@user/video/1')).toBe(true);
    expect(isBlockedHost('https://instagram.com/p/abc')).toBe(true);
    expect(isBlockedHost('https://facebook.com/page')).toBe(true);
    expect(isBlockedHost('https://youtube.com/watch?v=abc')).toBe(true);
    expect(isBlockedHost('https://x.com/user/status/1')).toBe(true);
  });

  it('returns true for subdomains of blocked domains', () => {
    expect(isBlockedHost('https://m.tiktok.com/v/1')).toBe(true);
    expect(isBlockedHost('https://www.instagram.com/reel/abc')).toBe(true);
    expect(isBlockedHost('https://music.youtube.com/watch')).toBe(true);
  });

  it('returns false for news / blog hosts', () => {
    expect(isBlockedHost('https://kompas.com/article/1')).toBe(false);
    expect(isBlockedHost('https://example.com/post')).toBe(false);
    expect(isBlockedHost('https://news.example.id/headline')).toBe(false);
  });

  it('returns false for look-alike domains that are not exact matches or subdomains', () => {
    // `not-tiktok.com` must NOT be blocked — it is nottiktok.com, not a
    // tiktok.com subdomain. False positives here would silently drop
    // legitimate sources.
    expect(isBlockedHost('https://not-tiktok.com/article')).toBe(false);
    expect(isBlockedHost('https://tiktok-news.com/article')).toBe(false);
    expect(isBlockedHost('https://myinstagram.com/post')).toBe(false);
  });

  it('returns false for invalid URLs (filtered by isUsableResult elsewhere)', () => {
    expect(isBlockedHost('not-a-url')).toBe(false);
    expect(isBlockedHost('')).toBe(false);
  });
});

describe('BLOCKED_HOST_PATTERNS', () => {
  it('covers the major Indonesian-audience social and short-video platforms', () => {
    expect(BLOCKED_HOST_PATTERNS).toContain('tiktok.com');
    expect(BLOCKED_HOST_PATTERNS).toContain('instagram.com');
    expect(BLOCKED_HOST_PATTERNS).toContain('facebook.com');
    expect(BLOCKED_HOST_PATTERNS).toContain('youtube.com');
    expect(BLOCKED_HOST_PATTERNS).toContain('x.com');
  });
});

describe('overlapsAwarenessDay', () => {
  const result = makeResult({ title: 'Hari Kartini dirayakan hari ini', snippet: '' });

  it('matches when a token appears in the title', () => {
    expect(overlapsAwarenessDay(result, ['kartini'])).toBe(true);
  });

  it('does not match when no token appears', () => {
    expect(overlapsAwarenessDay(result, ['pancasila'])).toBe(false);
  });

  it('returns false when the token list is empty', () => {
    expect(overlapsAwarenessDay(result, [])).toBe(false);
  });
});

describe('awarenessTokens', () => {
  it('splits on non-alphanumerics and drops tokens shorter than 4 chars', () => {
    expect(awarenessTokens('Hari Kartini Nasional')).toEqual(['hari', 'kartini', 'nasional']);
    expect(awarenessTokens('Hari Anak')).toEqual(['hari', 'anak']);
  });

  it('lowercases accented and numeric tokens', () => {
    expect(awarenessTokens('17-an Agustus 2026')).toEqual(['agustus', '2026']);
  });
});
