import { describe, expect, it } from 'vitest';

import { assertUnderGlobalBudget } from '../../../src/application/guards/budget-guard.js';
import { BudgetExhaustedError } from '../../../src/domain/errors.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { asChatId, asUsageEventId, asUserId } from '../../../src/domain/model/ids.js';
import { userRef } from '../../../src/domain/model/usage.js';
import type { UsageEvent } from '../../../src/domain/model/usage.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';

const CHAT_A = asChatId(-1_000_000_000_001);
const CHAT_B = asChatId(-2);
const USER_ID = asUserId(111);
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function event(id: string, chatId: typeof CHAT_A, costMicros: number, ts = NOW): UsageEvent {
  return {
    id: asUsageEventId(id),
    ts,
    chatId,
    threadId: null,
    user: userRef(USER_ID),
    model: 'claude-sonnet-5',
    phase: 'single',
    inputTokens: 0,
    outputTokens: 0,
    costMicros,
    unitPrices: PRICES,
    rangeSpec: '2h',
    questionHash: null,
    status: 'ok',
  };
}

describe('assertUnderGlobalBudget', () => {
  it('allows the call when nothing has been spent yet', async () => {
    const store = new FakeUsageStore();
    await expect(assertUnderGlobalBudget(store, NOW, 5)).resolves.toBeUndefined();
  });

  it('allows the call while spend is under the budget', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-1', CHAT_A, 4_000_000));
    await expect(assertUnderGlobalBudget(store, NOW, 5)).resolves.toBeUndefined();
  });

  it('is a hard stop: refuses once spend reaches the budget exactly', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-1', CHAT_A, 5_000_000));
    await expect(assertUnderGlobalBudget(store, NOW, 5)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('is a hard stop: refuses once spend exceeds the budget', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-1', CHAT_A, 6_000_000));
    await expect(assertUnderGlobalBudget(store, NOW, 5)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('sums spend across every chat: the budget is genuinely global', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-a', CHAT_A, 3_000_000));
    await store.record(CHAT_B, event('evt-b', CHAT_B, 3_000_000));
    await expect(assertUnderGlobalBudget(store, NOW, 5)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('ignores spend from before today (UTC): the trip clears at midnight', async () => {
    const store = new FakeUsageStore();
    await store.record(
      CHAT_A,
      event('evt-yesterday', CHAT_A, 10_000_000, Temporal.Instant.from('2026-09-16T23:59:59Z')),
    );
    await expect(assertUnderGlobalBudget(store, NOW, 5)).resolves.toBeUndefined();
  });

  it('a zero budget refuses every call — the hard-stop edge case', async () => {
    const store = new FakeUsageStore();
    await expect(assertUnderGlobalBudget(store, NOW, 0)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('reports the configured budget on the thrown error', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-1', CHAT_A, 5_000_000));
    try {
      await assertUnderGlobalBudget(store, NOW, 5);
      expect.unreachable('expected BudgetExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).budgetUsd).toBe(5);
    }
  });

  it('the error is flagged for the error sink (DESIGN §11: budget-cap trips are reportable)', async () => {
    const store = new FakeUsageStore();
    await store.record(CHAT_A, event('evt-1', CHAT_A, 5_000_000));
    try {
      await assertUnderGlobalBudget(store, NOW, 5);
      expect.unreachable('expected BudgetExhaustedError');
    } catch (error) {
      expect((error as BudgetExhaustedError).report).toBe(true);
    }
  });
});
