import type { SearxngSearchOutput, SearxngSearchResult } from '../searxng/client.js';
import type { Topic } from './special-days.js';

/**
 * SearXNG search seam for the weekly social-drafts workflow. Takes a single
 * query and returns the bounded search output produced by the existing
 * `search_web` tool / SearXNG client — no new transport, no crawler, no page
 * fetching. The default implementation in the workflow wraps `searchWebTool`.
 */
export type SearchFn = (query: string) => Promise<SearxngSearchOutput>;

/**
 * Default queries used to discover trending topics for the week. Phrased
 * news- and insight-oriented on purpose — words like "viral" in Indonesian
 * search signal content farms that aggregate TikTok/Reels clips, which is
 * not the brand-aligned input the workflow is meant to draft from. Three
 * queries so the diversification pass (one topic per query) still has
 * spares when a single query returns nothing usable.
 */
export const DEFAULT_TRENDING_QUERIES: readonly string[] = [
  'berita Indonesia minggu ini',
  'kabar teknologi Indonesia terkini',
  'isu hangat Indonesia pekan ini',
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
 *   title + snippet, and skips results whose host matches
 *   `BLOCKED_HOST_PATTERNS` (TikTok / Instagram / YouTube / etc.).
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

  for (const query of queries) {
    if (topics.length >= maxTopics) break;
    attemptedQueries += 1;
    let output: SearxngSearchOutput;
    try {
      output = await search(query);
    } catch {
      failedQueries += 1;
      continue;
    }
    // Diversify: take at most one topic from this query, then move on.
    for (const result of output.results) {
      if (!isUsableResult(result)) continue;
      if (isBlockedHost(result.url)) continue;
      if (seenUrls.has(result.url)) continue;
      if (overlapsAwarenessDay(result, excludeTokens)) continue;
      seenUrls.add(result.url);
      topics.push(resultToTopic(result));
      break;
    }
  }

  if (attemptedQueries > 0 && failedQueries === attemptedQueries) {
    throw new Error('Every SearXNG query failed during trending research.');
  }

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

/** Split an awareness day name into matchable lowercase tokens. */
export function awarenessTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4);
}

function isUsableResult(result: SearxngSearchResult): boolean {
  if (!result.url || !result.title.trim() || !result.snippet.trim()) return false;
  return true;
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
