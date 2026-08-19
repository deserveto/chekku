import { describe, expect, it, vi } from 'vitest';

import type { SearxngSearchOutput, SearxngSearchResult } from '../../searxng/client.js';
import type { WebReaderOutput } from '../../web-reader/client.js';
import {
  BLOCKED_HOST_PATTERNS,
  CREDIBLE_HOST_PATTERNS,
  DEFAULT_TRENDING_QUERIES,
  MAX_TRENDING_TOPICS,
  SENSITIVE_TOPIC_PATTERNS,
  awarenessTokens,
  isBlockedHost,
  isCredibleHost,
  isHomepageOrCategoryPage,
  isSensitiveTopic,
  overlapsAwarenessDay,
  researchTrendingTopics,
  type ReadPageFn,
  type SearchFn,
} from '../trending-research.js';

function makeResult(overrides: Partial<SearxngSearchResult> = {}): SearxngSearchResult {
  return {
    url: 'https://kompas.com/news/article',
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
        makeResult({ url: 'https://kompas.com/news/1', title: 'Trending One', snippet: 'Snip one.' }),
        makeResult({ url: 'https://kompas.com/news/2', title: 'Trending Two', snippet: 'Snip two.' }),
        makeResult({ url: 'https://kompas.com/news/3', title: 'Trending Three', snippet: 'Snip three.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(2);
    expect(topics.every((topic) => topic.kind === 'trending')).toBe(true);
    expect(topics[0]!.name).toBe('Trending One');
    expect(topics[0]!.source?.url).toBe('https://kompas.com/news/1');
    expect(topics[1]!.name).toBe('Trending Two');
  });

  it('uses the default queries and diversifies one topic per query', async () => {
    const search = vi.fn(async (_query: string): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com/news/2', title: 'B', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    // With diversify, each query contributes at most one topic. Two topics
    // means two queries were issued (not one query returning two topics).
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]![0]).toBe(DEFAULT_TRENDING_QUERIES[0]);
    expect(search.mock.calls[1]![0]).toBe(DEFAULT_TRENDING_QUERIES[1]);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://kompas.com/news/1',
      'https://kompas.com/news/2',
    ]);
  });

  it('skips social-media hosts (TikTok, Instagram, YouTube, etc.)', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://tiktok.com/@user/video/123', title: 'Trend TikTok', snippet: 'Viral.' }),
        makeResult({ url: 'https://www.instagram.com/reel/abc', title: 'IG Reel', snippet: 'Viral.' }),
        makeResult({ url: 'https://m.youtube.com/shorts/xyz', title: 'YT Short', snippet: 'Viral.' }),
        makeResult({ url: 'https://cnnindonesia.com/news/real-article', title: 'Real News', snippet: 'Actual reporting.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://cnnindonesia.com/news/real-article');
  });

  it('continues to the next query when the first returns fewer than maxTopics', async () => {
    const search = vi.fn(async (query: string): Promise<SearxngSearchOutput> => {
      if (query === DEFAULT_TRENDING_QUERIES[0]) {
        return makeOutput([makeResult({ url: 'https://kompas.com/news/1', title: 'Only One', snippet: 'Snip.' })]);
      }
      return makeOutput([makeResult({ url: 'https://tempo.co/news/2', title: 'Second Query Result', snippet: 'Snip.' })]);
    });

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(search).toHaveBeenCalledTimes(2);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://kompas.com/news/1',
      'https://tempo.co/news/2',
    ]);
  });

  it('dedupes the same URL across queries', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://detik.com/news/same', title: 'Same', snippet: 'Snip.' }),
        makeResult({ url: 'https://detik.com/news/other', title: 'Other', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(2);
    expect(topics.map((topic) => topic.source?.url)).toEqual([
      'https://detik.com/news/same',
      'https://detik.com/news/other',
    ]);
  });

  it('skips results without a usable title or snippet', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://kompas.com/news/no-title', title: '   ', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com/news/no-snip', title: 'Title', snippet: '' }),
        makeResult({ url: 'https://kompas.com/news/ok', title: 'Real Title', snippet: 'Real snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://kompas.com/news/ok');
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
      return makeOutput([makeResult({ url: 'https://kompas.com/news/2', title: 'Recovered', snippet: 'Snip.' })]);
    });

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toHaveLength(1);
    expect(topics[0]!.name).toBe('Recovered');
  });

  it('skips trending results that overlap the awareness day name tokens', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({
          url: 'https://kompas.com/news/related',
          title: 'Pers sempat viral hari ini',
          snippet: 'Berita tentang pers nasional minggu ini.',
        }),
        makeResult({
          url: 'https://kompas.com/news/unrelated',
          title: 'Tips hemat energi',
          snippet: 'Cara menghemat listrik.',
        }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, {
      excludeAwarenessDay: 'Hari Pers Nasional',
    });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://kompas.com/news/unrelated');
  });

  it('respects an explicit maxTopics override', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com/news/2', title: 'B', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com/news/3', title: 'C', snippet: 'Snip.' }),
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
        makeResult({ url: 'https://kompas.com/news/long', title: longTitle, snippet: longSnippet }),
      ]),
    );

    const [topic] = await researchTrendingTopics(search as SearchFn);

    expect(topic).toBeDefined();
    expect(topic!.name.length).toBeLessThanOrEqual(200);
    expect(topic!.angle.length).toBeLessThanOrEqual(400);
    // Original lengths preserved inside source for the prompt.
    expect(topic!.source?.title.length).toBe(500);
    expect(topic!.source?.snippet?.length).toBe(1000);
  });
});

describe('researchTrendingTopics — Web Reader enrichment (Phase 2b)', () => {
  function makeReaderOutput(url: string, markdown = '# Heading\n\nArticle body.'): WebReaderOutput {
    return {
      requestedUrl: url,
      sourceUrl: url,
      title: 'Article title',
      markdown,
      contentIsUntrusted: true,
      truncated: false,
    };
  }

  it('enriches each chosen topic with pageMarkdown when readPage is supplied', async () => {
    const search = vi.fn(async (query: string): Promise<SearxngSearchOutput> => {
      if (query === DEFAULT_TRENDING_QUERIES[0]) {
        return makeOutput([makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip.' })]);
      }
      return makeOutput([makeResult({ url: 'https://tempo.co/news/2', title: 'B', snippet: 'Snip.' })]);
    });
    const readPage = vi.fn(async (url: string) => makeReaderOutput(url, `# Page ${url}\n\nBody.`));

    const topics = await researchTrendingTopics(search as SearchFn, { readPage: readPage as ReadPageFn });

    expect(topics).toHaveLength(2);
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenCalledWith('https://kompas.com/news/1');
    expect(readPage).toHaveBeenCalledWith('https://tempo.co/news/2');
    expect(topics[0]!.source?.pageMarkdown).toBe('# Page https://kompas.com/news/1\n\nBody.');
    expect(topics[1]!.source?.pageMarkdown).toBe('# Page https://tempo.co/news/2\n\nBody.');
  });

  it('keeps the topic with snippet-only when its fetch rejects (Promise.allSettled)', async () => {
    const search = vi.fn(async (_query: string): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip A.' }),
        makeResult({ url: 'https://tempo.co/news/2', title: 'B', snippet: 'Snip B.' }),
      ]),
    );
    const readPage = vi.fn(async (url: string) => {
      if (url === 'https://kompas.com/news/1') throw new Error('network down');
      return makeReaderOutput(url);
    });

    const topics = await researchTrendingTopics(search as SearchFn, { readPage: readPage as ReadPageFn });

    expect(topics).toHaveLength(2);
    // Topic A: fetch failed → kept with snippet only (no pageMarkdown).
    expect(topics[0]!.source?.pageMarkdown).toBeUndefined();
    expect(topics[0]!.source?.snippet).toBe('Snip A.');
    // Topic B: fetch succeeded → enriched.
    expect(topics[1]!.source?.pageMarkdown).toBe('# Heading\n\nArticle body.');
  });

  it('skips the enrichment pass entirely when readPage is undefined', async () => {
    const search = vi.fn(async (_query: string): Promise<SearxngSearchOutput> =>
      makeOutput([makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip.' })]),
    );
    const readPage = vi.fn(async () => makeReaderOutput('https://kompas.com/news/1'));

    const topics = await researchTrendingTopics(search as SearchFn); // no readPage option

    expect(topics).toHaveLength(1);
    expect(readPage).not.toHaveBeenCalled();
    expect(topics[0]!.source?.pageMarkdown).toBeUndefined();
  });

  it('runs the fetches in parallel (Promise.allSettled, not sequential)', async () => {
    const search = vi.fn(async (query: string): Promise<SearxngSearchOutput> => {
      if (query === DEFAULT_TRENDING_QUERIES[0]) {
        return makeOutput([makeResult({ url: 'https://kompas.com/news/1', title: 'A', snippet: 'Snip.' })]);
      }
      return makeOutput([makeResult({ url: 'https://tempo.co/news/2', title: 'B', snippet: 'Snip.' })]);
    });
    const startTimes: Record<string, number> = {};
    const readPage = vi.fn(async (url: string) => {
      startTimes[url] = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return makeReaderOutput(url);
    });

    const start = Date.now();
    await researchTrendingTopics(search as SearchFn, { readPage: readPage as ReadPageFn });
    const elapsed = Date.now() - start;

    // If sequential, total time would be >= 100ms (2 × 50ms). Parallel
    // should be closer to 50ms. Use a loose lower bound to avoid flakiness
    // on slow CI.
    expect(elapsed).toBeLessThan(95);
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});

describe('isCredibleHost', () => {
  it('accepts whitelisted Indonesian news domains', () => {
    expect(isCredibleHost('https://kompas.com/read/abc')).toBe(true);
    expect(isCredibleHost('https://detik.com/news/x')).toBe(true);
    expect(isCredibleHost('https://tempo.co/berita/y')).toBe(true);
    expect(isCredibleHost('https://cnnindonesia.com/nasional/z')).toBe(true);
  });

  it('accepts whitelisted subdomains', () => {
    expect(isCredibleHost('https://tekno.kompas.com/read/x')).toBe(true);
    expect(isCredibleHost('https://inet.detik.com/news/y')).toBe(true);
  });

  it('accepts international credible domains', () => {
    expect(isCredibleHost('https://bbc.com/indonesia/123')).toBe(true);
    expect(isCredibleHost('https://reuters.com/article/abc')).toBe(true);
    expect(isCredibleHost('https://apnews.com/article/def')).toBe(true);
  });

  it('rejects non-credible hosts (blogspot, random blogs, content farms)', () => {
    expect(isCredibleHost('https://example.com/article')).toBe(false);
    expect(isCredibleHost('https://myblog.blogspot.com/post/1')).toBe(false);
    expect(isCredibleHost('https://viral-news-aggregator.xyz/article/abc')).toBe(false);
  });

  it('rejects look-alike domains that are not exact matches or subdomains', () => {
    expect(isCredibleHost('https://kompas-news.com/article')).toBe(false);
    expect(isCredibleHost('https://mykompas.com/article')).toBe(false);
    expect(isCredibleHost('https://not-bbc.com/article')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isCredibleHost('not-a-url')).toBe(false);
    expect(isCredibleHost('')).toBe(false);
  });
});

describe('isSensitiveTopic', () => {
  it('rejects politics-related results', () => {
    expect(isSensitiveTopic(makeResult({ title: 'Dinamika Politik Indonesia', snippet: 'Koalisi partai...' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Capres baru', snippet: 'Kampanye dimulai' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'DPR bahas RUU', snippet: 'Fraksi sepakat' }))).toBe(true);
  });

  it('rejects crime and violence results', () => {
    expect(isSensitiveTopic(makeResult({ title: 'Kasus penyelundupan plasenta', snippet: 'Polisi menangkap...' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Pembunuhan di Jakarta', snippet: 'Korban tewas' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Narkoba senilai miliaran', snippet: 'Digagalkan' }))).toBe(true);
  });

  it('rejects scandal and sensational results', () => {
    expect(isSensitiveTopic(makeResult({ title: 'Skandal koruptor', snippet: 'Terbongkar' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Viral aib artis', snippet: 'Netizen heboh' }))).toBe(true);
  });

  it('regression: rejects geopolitics results (Konflik Selat Hormuz, perang, sanksi)', () => {
    // PR #11 follow-up: "Konflik Selat Hormuz" slipped through because
    // the denylist had "konflik bersenjata" (compound) instead of bare
    // "konflik". Now bare "konflik" catches "konflik selat hormuz".
    expect(isSensitiveTopic(makeResult({ title: 'Konflik Selat Hormuz', snippet: 'Tensi memanas.' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Sanksi baru diberlakukan', snippet: 'Dampak ekonomi.' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Militer dikerahkan', snippet: 'Perang pecah.' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'Ketegangan antar negara', snippet: 'Diplomasi gagal.' }))).toBe(true);
  });

  it('allows neutral tech, lifestyle, sports, and positive news', () => {
    expect(isSensitiveTopic(makeResult({ title: 'AI Agent masa depan', snippet: 'Inovasi teknologi.' }))).toBe(false);
    expect(isSensitiveTopic(makeResult({ title: 'Tips hemat listrik', snippet: 'Gaya hidup hemat.' }))).toBe(false);
    expect(isSensitiveTopic(makeResult({ title: 'Startup raih pendanaan', snippet: 'Ekonomi kreatif tumbuh.' }))).toBe(false);
    expect(isSensitiveTopic(makeResult({ title: 'George Russell menang F1', snippet: 'Podium utama.' }))).toBe(false);
    expect(isSensitiveTopic(makeResult({ title: 'GoPay transfer luar negeri', snippet: 'Fitur baru.' }))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSensitiveTopic(makeResult({ title: 'POLITIK Hari Ini', snippet: 'Partai' }))).toBe(true);
    expect(isSensitiveTopic(makeResult({ title: 'KORUPSI', snippet: 'Dugaan' }))).toBe(true);
  });
});

describe('SENSITIVE_TOPIC_PATTERNS data integrity', () => {
  it('covers the major sensitive categories for the Indonesian audience', () => {
    // Politics
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('politik');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('pemilu');
    // Geopolitics
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('konflik');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('perang');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('sanksi');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('militer');
    // Crime
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('penyelundupan');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('korupsi');
    // Morbid
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('plasenta');
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('mayat');
    // Sensational
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('skandal');
  });

  it('uses bare "konflik" instead of compound "konflik bersenjata"', () => {
    // Regression: "Konflik Selat Hormuz" slipped through because the old
    // compound "konflik bersenjata" did not match "konflik selat hormuz".
    expect(SENSITIVE_TOPIC_PATTERNS).toContain('konflik');
    expect(SENSITIVE_TOPIC_PATTERNS).not.toContain('konflik bersenjata');
  });
});

describe('researchTrendingTopics — sensitive-topic filter integration', () => {
  it('rejects sensitive results and accepts the first neutral one from a query', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://kompas.com/news/politik-terkini', title: 'Politik Panas', snippet: 'Koalisi pecah.' }),
        makeResult({ url: 'https://kompas.com/news/skandal-baru', title: 'Skandal Koruptor', snippet: 'Terbongkar.' }),
        makeResult({ url: 'https://kompas.com/news/teknologi-baru', title: 'Teknologi AI', snippet: 'Inovasi terbaru.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://kompas.com/news/teknologi-baru');
  });
});

describe('CREDIBLE_HOST_PATTERNS data integrity', () => {
  it('covers the major Indonesian news and tech sources', () => {
    expect(CREDIBLE_HOST_PATTERNS).toContain('kompas.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('detik.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('tempo.co');
    expect(CREDIBLE_HOST_PATTERNS).toContain('cnnindonesia.com');
  });

  it('covers the additional Indonesian news sources that surface in real SearXNG queries', () => {
    // Liputan6, Okezone, Merdeka showed up as top results for
    // "berita Indonesia minggu ini" against the local SearXNG instance
    // and were initially rejected because they were missing from the
    // whitelist. Keep them here so the regression does not return.
    expect(CREDIBLE_HOST_PATTERNS).toContain('liputan6.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('okezone.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('merdeka.com');
  });

  it('covers international credible sources', () => {
    expect(CREDIBLE_HOST_PATTERNS).toContain('bbc.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('reuters.com');
    expect(CREDIBLE_HOST_PATTERNS).toContain('apnews.com');
  });
});

describe('isHomepageOrCategoryPage', () => {
  it('rejects root domains', () => {
    expect(isHomepageOrCategoryPage('https://bbc.com/')).toBe(true);
    expect(isHomepageOrCategoryPage('https://kompas.com')).toBe(true);
    expect(isHomepageOrCategoryPage('https://www.cnnindonesia.com/')).toBe(true);
  });

  it('allows single-segment category pages (Indonesian news sites surface fresh article lists on section pages)', () => {
    // Regression: when this filter rejected single-segment paths, real
    // SearXNG queries for "berita Indonesia minggu ini" returned zero
    // trending topics because every top result was a section page
    // (cnnindonesia.com/nasional, nasional.kompas.com, etc.). The filter
    // now only rejects true site roots.
    expect(isHomepageOrCategoryPage('https://bbc.com/indonesia')).toBe(false);
    expect(isHomepageOrCategoryPage('https://kompas.com/news')).toBe(false);
    expect(isHomepageOrCategoryPage('https://cnnindonesia.com/nasional')).toBe(false);
    expect(isHomepageOrCategoryPage('https://news.detik.com/')).toBe(false);
    expect(isHomepageOrCategoryPage('https://nasional.kompas.com/')).toBe(false);
  });

  it('accepts article URLs with 2+ path segments', () => {
    expect(isHomepageOrCategoryPage('https://bbc.com/indonesia/123')).toBe(false);
    expect(isHomepageOrCategoryPage('https://kompas.com/read/2026/07/abc')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isHomepageOrCategoryPage('not-a-url')).toBe(false);
    expect(isHomepageOrCategoryPage('')).toBe(false);
  });
});

describe('researchTrendingTopics — credible-source + homepage filters', () => {
  it('rejects results from non-credible hosts', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://random-blog.xyz/news/1', title: 'Random Blog', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com/news/credible', title: 'Credible News', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
    expect(topics[0]!.source?.url).toBe('https://kompas.com/news/credible');
  });

  it('rejects true homepage URLs even from credible hosts, but accepts single-segment category pages', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://bbc.com/', title: 'BBC Home', snippet: 'Snip.' }),
        makeResult({ url: 'https://bbc.com/indonesia', title: 'BBC Indonesia Section', snippet: 'Snip.' }),
        makeResult({ url: 'https://bbc.com/indonesia/article-123', title: 'Actual Article', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn, { maxTopics: 1 });

    expect(topics).toHaveLength(1);
    // BBC Home is rejected (root). BBC Indonesia section page is now
    // accepted because single-segment category pages are allowed — the
    // filter only rejects true site roots.
    expect(topics[0]!.source?.url).toBe('https://bbc.com/indonesia');
  });

  it('returns empty when no credible article URLs are present', async () => {
    const search = vi.fn(async (): Promise<SearxngSearchOutput> =>
      makeOutput([
        makeResult({ url: 'https://random-blog.xyz/news/1', title: 'Random', snippet: 'Snip.' }),
        makeResult({ url: 'https://kompas.com', title: 'Kompas Home (no path)', snippet: 'Snip.' }),
      ]),
    );

    const topics = await researchTrendingTopics(search as SearchFn);

    expect(topics).toEqual([]);
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
    expect(isBlockedHost('https://cnnindonesia.id/headline')).toBe(false);
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

  it('regression: a trending result that incidentally mentions "hari" is NOT discarded just because the bonus day is "Hari ..." ', () => {
    // Mas Gitgit review (PR #11): awarenessTokens used to keep the bare
    // `hari` token, so a result like "Cuaca panas 3 hari ke depan" was
    // dropped on every week that had a `Hari ...` bonus. The stoplist
    // removes `hari` from the token set, so the overlap check no longer
    // fires on incidental occurrences of `hari`.
    const weatherResult = makeResult({
      title: 'Cuaca panas 3 hari ke depan',
      snippet: 'BMKG memprediksi suhu udaya naik.',
    });
    const tokens = awarenessTokens('Hari Kartini Nasional');
    expect(tokens).not.toContain('hari');
    expect(overlapsAwarenessDay(weatherResult, tokens)).toBe(false);
  });
});

describe('awarenessTokens', () => {
  it('splits on non-alphanumerics, drops tokens shorter than 4 chars, and stops the generic "hari" word', () => {
    // Regression: "hari" is 4 chars and used to slip through the length
    // filter, but because nearly every Indonesian awareness day is named
    // `Hari ...`, that token then matched against any trending result
    // mentioning "hari" (e.g. "Cuaca panas 3 hari ke depan") — discarding
    // unrelated results. The stoplist now drops `hari` so the overlap
    // match keys on the actual theme word (Kartini, Guru, etc.).
    expect(awarenessTokens('Hari Kartini Nasional')).toEqual(['kartini', 'nasional']);
    expect(awarenessTokens('Hari Anak')).toEqual(['anak']);
  });

  it('lowercases accented and numeric tokens', () => {
    expect(awarenessTokens('17-an Agustus 2026')).toEqual(['agustus', '2026']);
  });

  it('does not stop "hari" inside a longer compound token', () => {
    // "Hardiraya" would still be kept because it is its own token. Only
    // the bare "hari" token is stopped.
    expect(awarenessTokens('Hardiraya Nasional')).toEqual(['hardiraya', 'nasional']);
  });
});
