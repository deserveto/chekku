import { describe, expect, it } from 'vitest';
import {
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
    try {
      store.assertQuota('user-1');
    } catch (error) {
      const quotaError = error as TokenQuotaExceededError;
      expect(quotaError.used).toBe(100);
      expect(quotaError.limit).toBe(100);
      expect(quotaError.message).toBe(quotaExceededMessage(100, 100));
    }
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
});
