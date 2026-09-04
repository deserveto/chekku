import { describe, expect, it } from 'vitest';
import {
  RunUsageTracker,
  TokenQuotaExceededError,
  TokenQuotaStore,
  quotaExceededMessage,
} from './token-quota.js';

const DAY_1_NOON = Date.UTC(2026, 7, 30, 12, 0, 0); // 2026-08-30
const DAY_2_NOON = Date.UTC(2026, 7, 31, 12, 0, 0); // 2026-08-31

function fixedStore(limit: number, at: number = DAY_1_NOON) {
  let now = at;
  const store = new TokenQuotaStore({ limit, now: () => now });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('quotaExceededMessage', () => {
  it('formats the fixed bounded message', () => {
    expect(quotaExceededMessage(500_000, 500_000)).toBe(
      'Daily token limit reached (500,000 of 500,000 tokens used). Resets at midnight UTC.',
    );
    expect(quotaExceededMessage(12_345, 10_000)).toBe(
      'Daily token limit reached (12,345 of 10,000 tokens used). Resets at midnight UTC.',
    );
  });
});

describe('TokenQuotaStore', () => {
  it('accumulates usage per resource independently', () => {
    const { store } = fixedStore(1000);
    store.consume('user-1', 100);
    store.consume('user-1', 50);
    store.consume('user-2', 30);
    expect(store.getUsage('user-1')).toEqual({ used: 150, limit: 1000 });
    expect(store.getUsage('user-2')).toEqual({ used: 30, limit: 1000 });
  });

  it('ignores non-positive or non-finite consumption', () => {
    const { store } = fixedStore(1000);
    store.consume('user-1', 0);
    store.consume('user-1', -5);
    store.consume('user-1', Number.NaN);
    expect(store.getUsage('user-1').used).toBe(0);
  });

  it('assertQuota passes below the limit and throws at the boundary', () => {
    const { store } = fixedStore(100);
    store.consume('user-1', 99);
    expect(() => store.assertQuota('user-1')).not.toThrow();
    store.consume('user-1', 1);
    expect(() => store.assertQuota('user-1')).toThrow(TokenQuotaExceededError);
    let caught: unknown;
    try {
      store.assertQuota('user-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TokenQuotaExceededError);
    const quotaError = caught as TokenQuotaExceededError;
    expect(quotaError.used).toBe(100);
    expect(quotaError.limit).toBe(100);
    expect(quotaError.message).toBe(quotaExceededMessage(100, 100));
  });

  it('resets lazily when the UTC day changes', () => {
    const { store, advance } = fixedStore(100);
    store.consume('user-1', 100);
    expect(() => store.assertQuota('user-1')).toThrow();
    advance(DAY_2_NOON - DAY_1_NOON);
    expect(store.getUsage('user-1')).toEqual({ used: 0, limit: 100 });
    expect(() => store.assertQuota('user-1')).not.toThrow();
  });

  it('enforces no quota when limit is 0', () => {
    const { store } = fixedStore(0);
    store.consume('user-1', Number.MAX_SAFE_INTEGER);
    expect(() => store.assertQuota('user-1')).not.toThrow();
  });

  it('bounds tracked resources, evicting the oldest-inserted entry', () => {
    const { store } = fixedStore(1000);
    const MAX = 10_000;
    for (let i = 0; i <= MAX; i++) {
      store.consume(`res-${i}`, 5);
    }
    // res-1 (next oldest) and the newest retain their usage — the size
    // never exceeded the cap (otherwise nothing would have been evicted).
    expect(store.getUsage('res-1')).toEqual({ used: 5, limit: 1000 });
    expect(store.getUsage(`res-${MAX}`)).toEqual({ used: 5, limit: 1000 });
    // Probing the evicted res-0 inserts a fresh entry (which in turn evicts
    // the now-oldest key, res-2 — hence asserted last).
    expect(store.getUsage('res-0')).toEqual({ used: 0, limit: 1000 });
  });
});

describe('RunUsageTracker', () => {
  function trackerOf() {
    const consumed: number[] = [];
    const tracker = new RunUsageTracker((tokens) => consumed.push(tokens));
    return { tracker, consumed };
  }

  // Runtime step-finish chunks carry BOTH shapes: `stepResult.totalUsage`
  // (cumulative across steps) and `output.usage` (per-step). Cumulative wins
  // whenever it parses.
  function stepChunk(cumulative: number, perStep = cumulative) {
    return {
      stepResult: { totalUsage: { totalTokens: cumulative } },
      output: { usage: { totalTokens: perStep } },
    };
  }

  it('consumes cumulative stepResult.totalUsage as deltas', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish(stepChunk(100));
    tracker.recordStepFinish(stepChunk(250));
    tracker.recordStepFinish(stepChunk(250));
    expect(consumed).toEqual([100, 150]);
    expect(tracker.consumed).toBe(250);
  });

  it('prefers the cumulative shape when both are present', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish(stepChunk(200, 9_999));
    expect(consumed).toEqual([200]);
    expect(tracker.consumed).toBe(200);
  });

  it('ignores non-monotonic cumulative reports', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish(stepChunk(200));
    tracker.recordStepFinish(stepChunk(50));
    expect(consumed).toEqual([200]);
  });

  it('falls back to inputTokens + outputTokens when totalTokens is absent', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({
      stepResult: { totalUsage: { inputTokens: 700, outputTokens: 300 } },
    });
    expect(consumed).toEqual([1000]);
  });

  it('consumes per-step output.usage additively when only it is present', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({ output: { usage: { totalTokens: 100 } } });
    tracker.recordStepFinish({ output: { usage: { totalTokens: 50 } } });
    expect(consumed).toEqual([100, 50]);
    expect(tracker.consumed).toBe(150);
  });

  it('reconciles the finish whole-run total, consuming only the shortfall', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish(stepChunk(100));
    tracker.recordFinish({ output: { usage: { totalTokens: 400 } } });
    tracker.recordFinish({ output: { usage: { totalTokens: 300 } } });
    expect(consumed).toEqual([100, 300]);
    expect(tracker.consumed).toBe(400);
  });

  it('does not double-count a late step-finish arriving after finish', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish(stepChunk(100));
    tracker.recordFinish({ output: { usage: { totalTokens: 400 } } });
    tracker.recordStepFinish(stepChunk(300));
    expect(consumed).toEqual([100, 300]);
    expect(tracker.consumed).toBe(400);
  });

  it('consumes everything at finish when steps reported no usage', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordFinish({
      output: { usage: { inputTokens: 60, outputTokens: 40 } },
    });
    expect(consumed).toEqual([100]);
  });

  it('is a no-op for malformed payloads', () => {
    const { tracker, consumed } = trackerOf();
    tracker.recordStepFinish({});
    tracker.recordStepFinish({ stepResult: {} });
    tracker.recordStepFinish({ output: {} });
    // The stale top-level `totalUsage` shape no longer exists at runtime.
    tracker.recordStepFinish({ totalUsage: { totalTokens: 500 } });
    tracker.recordStepFinish({ stepResult: { totalUsage: null } });
    tracker.recordStepFinish({
      stepResult: { totalUsage: { totalTokens: 'lots' } },
    });
    tracker.recordFinish({});
    tracker.recordFinish({ output: {} });
    tracker.recordFinish({ output: { usage: undefined } });
    expect(consumed).toEqual([]);
    expect(tracker.consumed).toBe(0);
  });
});
