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

  // No options -> limit 0 (unlimited); production wiring always passes env.TOKEN_DAILY_LIMIT.
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

type UnknownRecord = Record<string, unknown>;

/** Reads an AI SDK LanguageModelUsage-shaped value into a token total. */
function usageTotalTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as UnknownRecord;
  const total = record.totalTokens;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    return Math.floor(total);
  }
  const input = record.inputTokens;
  const output = record.outputTokens;
  if (
    typeof input === 'number' &&
    Number.isFinite(input) &&
    input >= 0 &&
    typeof output === 'number' &&
    Number.isFinite(output) &&
    output >= 0
  ) {
    return Math.floor(input + output);
  }
  return null;
}

/**
 * Records one run's token usage into a quota consumer, delta-only so nothing
 * is double-counted. Mastra's `step-finish` payload carries `totalUsage` —
 * cumulative usage across steps so far (AI SDK contract) — so each event
 * consumes only growth over the highest cumulative total seen. A gateway
 * variant that reports non-cumulatively (or not at all) is caught by
 * `recordFinish`, which reconciles against the whole-run total in
 * `output.usage` and consumes only the shortfall.
 */
export class RunUsageTracker {
  private readonly consume: (tokens: number) => void;
  private highestStepTotal = 0;
  private recorded = 0;

  constructor(consume: (tokens: number) => void) {
    this.consume = consume;
  }

  recordStepFinish(payload: UnknownRecord): void {
    const total = usageTotalTokens(payload.totalUsage);
    if (total === null || total <= this.highestStepTotal) return;
    const delta = total - this.highestStepTotal;
    this.highestStepTotal = total;
    this.recorded += delta;
    this.consume(delta);
  }

  recordFinish(payload: UnknownRecord): void {
    const output = payload.output;
    const usage =
      output && typeof output === 'object'
        ? (output as UnknownRecord).usage
        : undefined;
    const total = usageTotalTokens(usage);
    if (total === null || total <= this.recorded) return;
    const delta = total - this.recorded;
    this.recorded = total;
    this.highestStepTotal = Math.max(this.highestStepTotal, total);
    this.consume(delta);
  }

  get consumed(): number {
    return this.recorded;
  }
}

/** Server-wide singleton; process lifetime, single-instance invariant. */
export const tokenQuotaStore = new TokenQuotaStore({
  limit: env.TOKEN_DAILY_LIMIT,
});
