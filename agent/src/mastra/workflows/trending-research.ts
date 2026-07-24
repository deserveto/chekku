import type { SearxngSearchOutput, SearxngSearchResult } from '../searxng/client.js';
import type { WebReaderOutput } from '../web-reader/client.js';
import type { Topic } from './special-days.js';

/**
 * SearXNG search seam for the weekly social-drafts workflow. Takes a single
 * query and returns the bounded search output produced by the existing
 * `search_web` tool / SearXNG client — no new transport, no crawler, no page
 * fetching. The default implementation in the workflow wraps `searchWebTool`.
 */
export type SearchFn = (query: string) => Promise<SearxngSearchOutput>;

/**
 * Hosted-Web-Reader seam for enriching a chosen trending topic with the
 * actual page markdown of its source URL. Takes one public HTTP(S) URL and
 * returns the bounded Web Reader output. The default implementation in the
 * workflow wraps `readWebPageTool`.
 *
 * Optional — when undefined, `researchTrendingTopics` skips page enrichment
 * and returns topics that carry only the SearXNG snippet.
 */
export type ReadPageFn = (url: string) => Promise<WebReaderOutput>;

/**
 * Default queries used to discover trending topics for the week. Structured
 * to produce **1 technology slot + 1 general slot** via the diversify
 * (one-topic-per-query) pass:
 *
 * - Query 1: technology and innovation news (slot 1 = tech).
 * - Query 2: general Indonesian trending news — any topic except sensitive
 *   (politics, crime, etc. filtered by the denylist below). Sports, economy,
 *   lifestyle are all acceptable here.
 * - Query 3: backup / positive lifestyle fallback when query 1 or 2 returns
 *   nothing usable after all filters.
 *
 * "Terkini" / "minggu ini" / "pekan ini" steer SearXNG toward fresh results
 * — local SearXNG instances often ignore the `time_range` parameter, so the
 * freshness signal lives in the query string itself.
 */
export const DEFAULT_TRENDING_QUERIES: readonly string[] = [
  'berita teknologi inovasi terkini',
  'berita terkini Indonesia minggu ini',
  'tren positif gaya hidup Indonesia pekan ini',
] as const;

/**
 * Keywords whose presence in a result's title or snippet marks the topic as
 * sensitive — politics, geopolitics/conflict, crime/violence, morbid/
 * disturbing content, or sensational scandals. The brand voice is warm and
 * gentle; these topics do not belong in the output regardless of how
 * trending they are. Brand-safety filter applied after the credible-source +
 * homepage filters, before the overlap and enrichment passes.
 *
 * Matching is case-insensitive substring on the lowercased title + snippet.
 * Sports (F1, football, badminton) are NOT filtered — they are acceptable
 * general trending topics.
 */
export const SENSITIVE_TOPIC_PATTERNS: readonly string[] = [
  // Politics & geopolitics
  'politik', 'partai', 'pemilu', 'pilkada', 'pilpres',
  'capres', 'caleg', 'koalisi', 'oposisi', 'kampanye',
  'dpr', 'mpr', 'fraksi',
  'konflik', 'perang', 'sanksi', 'ketegangan',
  'militer', 'geopolitik', 'persenjataan',
  // Crime & violence
  'pembunuhan', 'penyelundupan', 'pencurian', 'perampokan',
  'korupsi', 'narkoba', 'kekerasan', 'pelecehan', 'pemerkosaan',
  'penculikan', 'penembakan', 'pemerasan', 'penganiayaan',
  // Disturbing / morbid
  'plasenta', 'mayat', 'mutilasi', 'pembantaian', 'bunuh diri',
  'perdagangan organ',
  // Conflict & terrorism
  'teroris', 'peledakan',
  // Sensational / scandal
  'skandal', 'aib', 'asusila',
] as const;

/**
 * Hosts we never accept trending results from. Social-media domains and
 * short-video platforms dominate results for any query containing the words
 * "tren" or "viral" in Indonesian; without this filter, the workflow ends
 * up drafting brand posts about TikTok/Instagram trends instead of the
 * news/insight content the brand voice is designed for.
 *
 * Subdomains are blocked too (`m.tiktok.com`, `www.instagram.com`, etc.).
 */
export const BLOCKED_HOST_PATTERNS: readonly string[] = [
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'youtube.com',
  'pinterest.com',
  'twitter.com',
  'x.com',
  'snapchat.com',
] as const;

/**
 * Credible-news whitelist. After blocking social-media hosts, we further
 * require that any accepted trending result comes from a recognized
 * credible Indonesian or international news source. This drops blogspam,
 * content farms, and aggregator sites that pollute Indonesian search
 * results. Subdomains match (e.g. `tekno.kompas.com`, `bbc.com/indonesia`).
 *
 * If a query returns no whitelisted host, the diversification pass moves
 * on to the next query — falling back to evergreen pillars only when
 * every query is empty of credible results.
 *
 * Note: Indonesian news sites (Kompas, Detik, Liputan6, Okezone, Merdeka,
 * CNN Indonesia) often return their category pages (`cnnindonesia.com/nasional`,
 * `nasional.kompas.com`) as top results for news queries. Those pages are
 * fresh article lists and are accepted — the homepage filter only rejects
 * true site roots.
 */
export const CREDIBLE_HOST_PATTERNS: readonly string[] = [
  // Indonesia — general news
  'kompas.com',
  'detik.com',
  'tempo.co',
  'antaranews.com',
  'cnnindonesia.com',
  'cnbcindonesia.com',
  'viva.co.id',
  'tribunnews.com',
  'kumparan.com',
  'bisnis.com',
  'republika.co.id',
  'suara.com',
  'liputan6.com',
  'okezone.com',
  'merdeka.com',
  // Indonesia — tech verticals
  'inet.detik.com',
  'tekno.kompas.com',
  'tekno.tempo.co',
  // International
  'bbc.com',
  'reuters.com',
  'apnews.com',
  'theguardian.com',
  'bloomberg.com',
  'thejakartapost.com',
] as const;

/** Maximum topics a single research pass returns (the 2 base trending slots). */
export const MAX_TRENDING_TOPICS = 2;

export interface ResearchTrendingOptions {
  /** Maximum topics to return. Defaults to `MAX_TRENDING_TOPICS`. */
  maxTopics?: number;
  /** Override the default queries (mainly for tests). */
  queries?: readonly string[];
  /**
   * Awareness day name picked for the same week (Stage 2 bonus slot), used to
   * skip overlapping trending results so the bonus post and a trending post do
   * not duplicate the same theme. Optional.
   */
  excludeAwarenessDay?: string;
  /**
   * Optional Web Reader seam. When supplied, each chosen topic is enriched
   * with the markdown of its source URL via `Promise.allSettled`. Failures
   * are swallowed per-topic — the topic stays in the result with snippet
   * only (no `pageMarkdown`). When undefined, no fetch is attempted.
   */
  readPage?: ReadPageFn;
}

/**
 * Run a bounded trending-research pass against SearXNG and map results to
 * `Topic` entries with `kind: 'trending'`.
 *
 * - Calls `search` once per query in order until `maxTopics` is reached.
 * - Diversifies by taking **at most one topic per query** so the 2 base
 *   slots come from genuinely different searches instead of two results
 *   from the same SERP. A query that returns nothing usable is skipped
 *   silently and the next query takes its slot.
 * - Continues to the next query when one query throws, so a transient
 *   failure on a single phrase does not zero out the pass.
 * - Throws when every query failed, so the caller can mark the pass as
 *   degraded and switch off downstream behavior that depends on a healthy
 *   research seam (the awareness-day bonus in the weekly workflow).
 * - Deduplicates by URL across queries, skips results without a usable
 *   title + snippet, skips results whose host matches
 *   `BLOCKED_HOST_PATTERNS` (TikTok / Instagram / YouTube / etc.),
 *   requires the host to match `CREDIBLE_HOST_PATTERNS` (recognized
 *   Indonesian + international news sources), rejects root-domain
 *   homepages (`bbc.com/`, `kompas.com`), and drops results whose title
 *   or snippet match `SENSITIVE_TOPIC_PATTERNS` (politics, crime, violence,
 *   morbid content, scandals) so the brand voice stays warm and gentle.
 * - Skips results whose title or snippet overlaps the week's awareness day
 *   (best-effort token match) when `excludeAwarenessDay` is provided.
 */
export async function researchTrendingTopics(
  search: SearchFn,
  options: ResearchTrendingOptions = {},
): Promise<Topic[]> {
  const maxTopics = clampPositiveInt(options.maxTopics, MAX_TRENDING_TOPICS);
  const queries = options.queries ?? DEFAULT_TRENDING_QUERIES;
  const excludeTokens = options.excludeAwarenessDay
    ? awarenessTokens(options.excludeAwarenessDay)
    : [];

  const seenUrls = new Set<string>();
  const topics: Topic[] = [];
  let attemptedQueries = 0;
  let failedQueries = 0;

  console.log('[weekly-social-drafts] Researching trending topics...');
  for (const query of queries) {
    if (topics.length >= maxTopics) break;
    attemptedQueries += 1;
    console.log(`[weekly-social-drafts] Searching: "${query}"`);
    let output: SearxngSearchOutput;
    try {
      output = await search(query);
    } catch {
      failedQueries += 1;
      console.log(`[weekly-social-drafts]   → search failed, skipping`);
      continue;
    }
    console.log(`[weekly-social-drafts]   → ${output.results.length} results from SearXNG`);
    // Diversify: take at most one topic from this query, then move on.
    let rejectedCount = 0;
    for (const result of output.results) {
      if (!isUsableResult(result)) { rejectedCount++; continue; }
      if (isBlockedHost(result.url)) { rejectedCount++; continue; }
      if (!isCredibleHost(result.url)) { rejectedCount++; continue; }
      if (isHomepageOrCategoryPage(result.url)) { rejectedCount++; continue; }
      if (isSensitiveTopic(result)) { rejectedCount++; continue; }
      if (seenUrls.has(result.url)) { rejectedCount++; continue; }
      if (overlapsAwarenessDay(result, excludeTokens)) { rejectedCount++; continue; }
      seenUrls.add(result.url);
      topics.push(resultToTopic(result));
      console.log(`[weekly-social-drafts]   → selected: "${result.title.slice(0, 60)}" (${result.url})`);
      break;
    }
    if (topics.length < maxTopics && rejectedCount > 0) {
      console.log(`[weekly-social-drafts]   → ${rejectedCount} results rejected by filters (blocked host / non-credible / homepage / sensitive / duplicate)`);
    }
  }

  if (attemptedQueries > 0 && failedQueries === attemptedQueries) {
    throw new Error('Every SearXNG query failed during trending research.');
  }

  // Optional Web-Reader enrichment. Fetch the chosen topics' source URLs in
  // parallel after the diversification pass so each fetch is bounded to one
  // already-filtered URL. Per-topic failures are swallowed: the topic stays
  // in the result with snippet only, so a single unreachable URL never drops
  // a base slot. The returned markdown is untrusted evidence — the workflow
  // prompt instructs the drafter to treat it as context, never instructions.
  if (options.readPage && topics.length > 0) {
    console.log(`[weekly-social-drafts] Enriching ${topics.length} topic(s) via Web Reader...`);
    const settled = await Promise.allSettled(
      topics.map((topic) => (topic.source ? options.readPage!(topic.source.url) : Promise.reject(new Error('no source url')))),
    );
    settled.forEach((result, index) => {
      const topicName = topics[index]!.name.slice(0, 50);
      const url = topics[index]!.source?.url ?? 'unknown';
      if (result.status === 'fulfilled' && topics[index]!.source) {
        topics[index]!.source.pageMarkdown = result.value.markdown;
        console.log(`[weekly-social-drafts]   → enriched "${topicName}" (${result.value.markdown.length} chars from ${url})`);
      } else {
        console.log(`[weekly-social-drafts]   → failed to enrich "${topicName}" — using snippet only`);
      }
    });
  }

  console.log(`[weekly-social-drafts] Research complete: ${topics.length} trending topic(s)`);
  return topics;
}

/**
 * Token-based overlap heuristic: returns true when the awareness day's
 * meaningful tokens (length >= 4) appear in the result title or snippet.
 * Public for unit testing.
 */
export function overlapsAwarenessDay(
  result: SearxngSearchResult,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return false;
  const haystack = `${result.title} ${result.snippet}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/**
 * Stopword tokens filtered out of awareness-day overlap matching. Nearly
 * every Indonesian awareness day is named `Hari ...`, so `hari` would be
 * emitted as a 4-char token, pass the `length >= 4` filter, and then match
 * against any trending result that mentions the word `hari` (e.g.
 * "Cuaca panas 3 hari ke depan") — a false-positive that throws away
 * unrelated trending results exactly when the bonus slot is active,
 * pushing the run into the evergreen fallback.
 *
 * Stoplist kept minimal on purpose; tokens like `nasional`, `internasional`,
 * `sedunia` are specific enough to be safe to match.
 */
const STOPWORD_TOKENS: ReadonlySet<string> = new Set(['hari']);

/** Split an awareness day name into matchable lowercase tokens. */
export function awarenessTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4)
    .filter((token) => !STOPWORD_TOKENS.has(token));
}

function isUsableResult(result: SearxngSearchResult): boolean {
  if (!result.url || !result.title.trim() || !result.snippet.trim()) return false;
  return true;
}

/**
 * Returns true when the result's title or snippet contains any keyword from
 * `SENSITIVE_TOPIC_PATTERNS`. Brand-safety filter: the workflow must never
 * draft captions about politics, crime, violence, morbid/disturbing content,
 * or sensational scandals, regardless of how trending the topic is.
 *
 * Public for unit testing.
 */
export function isSensitiveTopic(result: SearxngSearchResult): boolean {
  const haystack = `${result.title} ${result.snippet}`.toLowerCase();
  return SENSITIVE_TOPIC_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Returns true when `url`'s host matches any pattern in
 * `BLOCKED_HOST_PATTERNS`. Handles bare domains and subdomains
 * (`tiktok.com`, `m.tiktok.com`, `www.instagram.com`). Invalid URLs return
 * false — the caller's downstream `isUsableResult` check rejects empty URLs
 * separately.
 *
 * Public for unit testing.
 */
export function isBlockedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_HOST_PATTERNS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Returns true when `url`'s host matches any pattern in
 * `CREDIBLE_HOST_PATTERNS`. Subdomains match too (`tekno.kompas.com`,
 * `bbc.com/indonesia`).
 *
 * Public for unit testing.
 */
export function isCredibleHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return CREDIBLE_HOST_PATTERNS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Returns true when `url` is a bare-domain homepage that matches an entry
 * in `CREDIBLE_HOST_PATTERNS` exactly (after stripping `www.`). We reject
 * these to avoid site homepages (`bbc.com/`, `kompas.com`, `viva.co.id`)
 * becoming trending topics — they have no single coherent article to
 * draft from.
 *
 * Subdomain roots (`news.detik.com/`, `nasional.kompas.com/`,
 * `tekno.kompas.com/`) are **allowed** because Indonesian news sites use
 * subdomain-as-section pattern: the subdomain IS the section, so the
 * subdomain root is effectively a category page that surfaces fresh
 * articles. Single-segment path pages (`cnnindonesia.com/nasional`) are
 * also allowed for the same reason.
 *
 * Examples:
 *   `https://bbc.com/`                       → true  (bare domain in whitelist)
 *   `https://www.bbc.com/`                   → true  (www stripped, matches bbc.com)
 *   `https://kompas.com`                     → true  (bare domain in whitelist)
 *   `https://viva.co.id`                     → true  (bare .co.id in whitelist)
 *   `https://news.detik.com/`                → false (subdomain root, allowed)
 *   `https://nasional.kompas.com/`           → false (subdomain root, allowed)
 *   `https://cnnindonesia.com/nasional`      → false (has path, allowed)
 *   `https://bbc.com/indonesia/123`          → false (has path, allowed)
 *
 * Public for unit testing.
 */
export function isHomepageOrCategoryPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const trimmed = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (trimmed.length > 0) return false; // has a path → not a homepage
  // Empty path → check if host is a bare whitelisted domain (after stripping
  // `www.`). Subdomain roots (news.detik.com) are not in CREDIBLE_HOST_PATTERNS
  // verbatim, so they pass through.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return CREDIBLE_HOST_PATTERNS.includes(host);
}

function resultToTopic(result: SearxngSearchResult): Topic {
  const title = result.title.trim();
  const snippet = result.snippet.trim();
  return {
    kind: 'trending',
    name: truncateText(title, 200),
    angle: truncateText(snippet, 400),
    source: {
      url: result.url,
      title,
      snippet,
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    },
  };
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  if (intValue < 0) return 0;
  return intValue;
}
