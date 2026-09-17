import { describe, expect, it } from 'vitest';

import { assertUnderDailyCap, startOfUtcDay } from '../../../src/application/guards/daily-cap-guard.js';
import { DailyCapError } from '../../../src/domain/errors.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { asChatId, asUsageEventId, asUserId } from '../../../src/domain/model/ids.js';
import { userRef } from '../../../src/domain/model/usage.js';
import type { UsageEvent } from '../../../src/domain/model/usage.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const USER_ID = asUserId(111);
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function event(id: string, ts: Temporal.Instant): UsageEvent {
  return {
    id: asUsageEventId(id),
    ts,
    chatId: CHAT_ID,
    threadId: null,
    user: userRef(USER_ID),
    model: 'claude-sonnet-5',
    phase: 'single',
    inputTokens: 100,
    outputTokens: 100,
    costMicros: 1_800,
    unitPrices: PRICES,
    rangeSpec: '2h',
    questionHash: null,
    status: 'ok',
  };
}

async function seed(store: FakeUsageStore, count: number, ts: Temporal.Instant): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.record(CHAT_ID, event(`evt-${String(i)}`, ts));
  }
}

describe('startOfUtcDay', () => {
  it('floors to midnight UTC on the same calendar day', () => {
    expect(startOfUtcDay(NOW).toString()).toBe('2026-09-17T00:00:00Z');
  });

  it('is idempotent', () => {
    const once = startOfUtcDay(NOW);
    expect(startOfUtcDay(once).equals(once)).toBe(true);
  });
});

describe('assertUnderDailyCap', () => {
  it('allows a chat with no calls today', async () => {
    const store = new FakeUsageStore();
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).resolves.toBeUndefined();
  });

  it('allows a chat under the cap', async () => {
    const store = new FakeUsageStore();
    await seed(store, 4, NOW);
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).resolves.toBeUndefined();
  });

  it('refuses once the chat has reached the cap', async () => {
    const store = new FakeUsageStore();
    await seed(store, 5, NOW);
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).rejects.toBeInstanceOf(DailyCapError);
  });

  it('refuses further over the cap, not only exactly at it', async () => {
    const store = new FakeUsageStore();
    await seed(store, 9, NOW);
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).rejects.toBeInstanceOf(DailyCapError);
  });

  it('does not count calls from before today (UTC)', async () => {
    const store = new FakeUsageStore();
    await seed(store, 5, Temporal.Instant.from('2026-09-16T23:59:59Z'));
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).resolves.toBeUndefined();
  });

  it('does not count another chat’s calls (DESIGN §6.1: never cross chats)', async () => {
    const store = new FakeUsageStore();
    const otherChat = asChatId(-2);
    for (let i = 0; i < 10; i += 1) {
      await store.record(otherChat, { ...event(`other-${String(i)}`, NOW), chatId: otherChat });
    }
    await expect(assertUnderDailyCap(store, CHAT_ID, NOW, 5)).resolves.toBeUndefined();
  });

  it('reports the configured limit on the thrown error', async () => {
    const store = new FakeUsageStore();
    await seed(store, 5, NOW);
    try {
      await assertUnderDailyCap(store, CHAT_ID, NOW, 5);
      expect.unreachable('expected DailyCapError');
    } catch (error) {
      expect(error).toBeInstanceOf(DailyCapError);
      expect((error as DailyCapError).limit).toBe(5);
    }
  });
});
