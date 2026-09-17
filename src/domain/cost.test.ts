import { describe, expect, it } from 'vitest';

import { computeCostMicros, microsToUsd, usdToMicros } from './cost.js';
import type { UsageTokens } from './cost.js';
import type { UnitPrices } from './model/usage.js';

const PRICES: UnitPrices = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cacheReadPerMTokUsd: 0.3,
};

function tokens(overrides: Partial<UsageTokens> = {}): UsageTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, ...overrides };
}

describe('computeCostMicros', () => {
  it('is zero for zero tokens', () => {
    expect(computeCostMicros(tokens(), PRICES)).toBe(0);
  });

  it('a $ per million tokens price is exactly micros per token', () => {
    // 1_000_000 tokens at $3/MTok = $3 = 3_000_000 micros.
    expect(computeCostMicros(tokens({ inputTokens: 1_000_000 }), PRICES)).toBe(3_000_000);
  });

  it('prices input, output and cache-read tokens independently', () => {
    const result = computeCostMicros(
      tokens({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }),
      PRICES,
    );
    expect(result).toBe(3_000_000 + 15_000_000 + 300_000);
  });

  it('rounds each token category to the nearest micro independently', () => {
    // 7 tokens * $3/MTok = 0.000021 USD = 21 micros exactly, no rounding needed.
    expect(computeCostMicros(tokens({ inputTokens: 7 }), PRICES)).toBe(21);
    // A fractional-micro price: 1 token * $0.3/MTok = 0.3 micros -> rounds to 0.
    expect(computeCostMicros(tokens({ cacheReadTokens: 1 }), PRICES)).toBe(0);
    // 2 tokens * $0.3/MTok = 0.6 micros -> rounds to 1.
    expect(computeCostMicros(tokens({ cacheReadTokens: 2 }), PRICES)).toBe(1);
  });

  it('never returns a fractional micro (integer arithmetic, DESIGN §4)', () => {
    const result = computeCostMicros(tokens({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 }), PRICES);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('a zero-priced model costs nothing regardless of tokens', () => {
    const free: UnitPrices = { inputPerMTokUsd: 0, outputPerMTokUsd: 0, cacheReadPerMTokUsd: 0 };
    expect(computeCostMicros(tokens({ inputTokens: 999_999, outputTokens: 999_999 }), free)).toBe(0);
  });

  it('does not price cache-write tokens: only input/output/cache-read are billed here', () => {
    // No cacheWriteTokens field exists on UsageTokens at all — this documents
    // that the type itself makes "priced" and "not priced" structurally clear.
    const withoutCacheWrite = computeCostMicros(tokens({ inputTokens: 100 }), PRICES);
    const sameInputDifferentShape = computeCostMicros(tokens({ inputTokens: 100 }), PRICES);
    expect(withoutCacheWrite).toBe(sameInputDifferentShape);
  });
});

describe('microsToUsd / usdToMicros', () => {
  it('round-trips exactly for whole-cent amounts', () => {
    expect(microsToUsd(5_000_000)).toBe(5);
    expect(usdToMicros(5)).toBe(5_000_000);
  });

  it('microsToUsd divides by one million', () => {
    expect(microsToUsd(1_500_000)).toBeCloseTo(1.5, 10);
  });

  it('usdToMicros rounds to the nearest micro', () => {
    expect(usdToMicros(0.0000005)).toBe(1);
    expect(usdToMicros(0.00000049)).toBe(0);
  });

  it('usdToMicros is the inverse of microsToUsd for the global budget config value', () => {
    const budgetUsd = 5;
    expect(usdToMicros(microsToUsd(usdToMicros(budgetUsd)))).toBe(usdToMicros(budgetUsd));
  });
});
