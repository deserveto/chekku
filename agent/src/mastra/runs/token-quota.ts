/**
 * In-memory per-user daily token quota.
 *
 * Same philosophy as the run registry: the agent server is single-instance,
 * so counters live in the process and die with it (a restart gives every
 * user a fresh daily quota). No SQL, no Garage — durability was rejected in
 * the design (see docs/superpowers/specs/2026-08-30-token-quota-design.md).
 * The public surface stays narrow so a durable store can replace the Map
 * without touching call sites.
 */

import { env } from '../../config/env.js';

/** Fixed bounded message; surfaced as HTTP 429 without diagnostics. */
export function quotaExceededMessage(used: number, limit: number): string {
  return `Daily token limit reached (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens used). Resets at midnight UTC.`;
}

export class TokenQuotaExceededError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(quotaExceededMessage(used, limit));
    this.name = 'TokenQuotaExceededError';
    this.used = used;
    this.limit = limit;
  }
}

/** Structural subset of TokenQuotaStore consumed by the run execution loop. */
export interface TokenQuotaConsumer {
  consume(resourceId: string, tokens: number): void;
}

export interface TokenQuotaStoreOptions {
  /** Daily token budget per resourceId; 0 disables enforcement. */
  limit?: number;
  /** Injectable epoch-ms clock, mirroring RunRegistryOptions.now. */
  now?: () => number;
}

interface QuotaEntry {
  /** UTC day as YYYY-MM-DD. */
  day: string;
  used: number;
}

export class TokenQuotaStore implements TokenQuotaConsumer {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, QuotaEntry>();

  constructor(options: TokenQuotaStoreOptions = {}) {
    this.limit = Math.max(0, Math.floor(options.limit ?? 0));
    this.now = options.now ?? Date.now;
  }

  private currentDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private entry(resourceId: string): QuotaEntry {
    const day = this.currentDay();
    const existing = this.entries.get(resourceId);
    if (!existing || existing.day !== day) {
      // Lazy day rollover: a stale entry from a previous UTC day resets to 0.
      const fresh: QuotaEntry = { day, used: 0 };
      this.entries.set(resourceId, fresh);
      return fresh;
    }
    return existing;
  }

  getUsage(resourceId: string): { used: number; limit: number } {
    return { used: this.entry(resourceId).used, limit: this.limit };
  }

  consume(resourceId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.entry(resourceId).used += Math.floor(tokens);
  }

  assertQuota(resourceId: string): void {
    if (this.limit <= 0) return;
    const { used } = this.entry(resourceId);
    if (used >= this.limit) throw new TokenQuotaExceededError(used, this.limit);
  }
}

/** Server-wide singleton; process lifetime, single-instance invariant. */
export const tokenQuotaStore = new TokenQuotaStore({
  limit: env.TOKEN_DAILY_LIMIT,
});
