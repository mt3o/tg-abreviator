import { describe, expect, it } from 'vitest';

import { InMemoryUsageRollupSink, runUsageRollup } from '../../../src/application/usage/rollup.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { asChatId, asUsageEventId, asUserId } from '../../../src/domain/model/ids.js';
import { userRef } from '../../../src/domain/model/usage.js';
import type { UsageEvent } from '../../../src/domain/model/usage.js';
import { FakeMaintenanceStore } from '../../fakes/fake-maintenance-store.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';

const CHAT_A = asChatId(-1);
const CHAT_B = asChatId(-2);
const USER_ID = asUserId(111);
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function event(chatId: typeof CHAT_A, costMicros: number): UsageEvent {
  return {
    id: asUsageEventId(`evt-${String(Math.random())}`),
    ts: NOW,
    chatId,
    threadId: null,
    user: userRef(USER_ID),
    model: 'claude-sonnet-5',
    phase: 'single',
    inputTokens: 10,
    outputTokens: 10,
    costMicros,
    unitPrices: PRICES,
    rangeSpec: '2h',
    questionHash: null,
    status: 'ok',
  };
}

describe('runUsageRollup', () => {
  it('produces one rollup per known chat plus one global rollup', async () => {
    const usage = new FakeUsageStore();
    await usage.record(CHAT_A, event(CHAT_A, 1_000_000));
    await usage.record(CHAT_B, event(CHAT_B, 2_000_000));
    const maintenance = new FakeMaintenanceStore(usage);
    const sink = new InMemoryUsageRollupSink();

    const rollups = await runUsageRollup(
      { maintenance, usage, globalUsage: usage },
      { since: NOW.subtract({ hours: 1 }), until: NOW.add({ hours: 1 }) },
      sink,
      NOW,
    );

    expect(rollups).toHaveLength(3);
    expect(rollups.filter((r) => r.scope.kind === 'chat')).toHaveLength(2);
    expect(rollups.filter((r) => r.scope.kind === 'global')).toHaveLength(1);
  });

  it('publishes every rollup to the sink', async () => {
    const usage = new FakeUsageStore();
    await usage.record(CHAT_A, event(CHAT_A, 500_000));
    const maintenance = new FakeMaintenanceStore(usage);
    const sink = new InMemoryUsageRollupSink();

    await runUsageRollup(
      { maintenance, usage, globalUsage: usage },
      { since: NOW.subtract({ hours: 1 }), until: NOW.add({ hours: 1 }) },
      sink,
      NOW,
    );

    expect(sink.published).toHaveLength(2);
  });

  it('the global rollup sums cost across every chat', async () => {
    const usage = new FakeUsageStore();
    await usage.record(CHAT_A, event(CHAT_A, 1_000_000));
    await usage.record(CHAT_B, event(CHAT_B, 2_000_000));
    const maintenance = new FakeMaintenanceStore(usage);
    const sink = new InMemoryUsageRollupSink();

    const rollups = await runUsageRollup(
      { maintenance, usage, globalUsage: usage },
      { since: NOW.subtract({ hours: 1 }), until: NOW.add({ hours: 1 }) },
      sink,
      NOW,
    );

    const global = rollups.find((r) => r.scope.kind === 'global');
    expect(global?.summary.costMicros).toBe(3_000_000);
  });

  it('produces an all-zero rollup for a chat with zero calls in the window, rather than skipping it', async () => {
    const usage = new FakeUsageStore();
    const maintenance = new FakeMaintenanceStore(usage);
    maintenance.add(CHAT_A);
    const sink = new InMemoryUsageRollupSink();

    const rollups = await runUsageRollup(
      { maintenance, usage, globalUsage: usage },
      { since: NOW.subtract({ hours: 1 }), until: NOW.add({ hours: 1 }) },
      sink,
      NOW,
    );

    const chatRollup = rollups.find((r) => r.scope.kind === 'chat' && r.scope.chatId === CHAT_A);
    expect(chatRollup).toBeDefined();
    expect(chatRollup?.summary.calls).toBe(0);
  });

  it('never carries a user reference on any rollup (DESIGN §4: rollups carry no user_id)', async () => {
    const usage = new FakeUsageStore();
    await usage.record(CHAT_A, event(CHAT_A, 1_000_000));
    const maintenance = new FakeMaintenanceStore(usage);
    const sink = new InMemoryUsageRollupSink();

    const rollups = await runUsageRollup(
      { maintenance, usage, globalUsage: usage },
      { since: NOW.subtract({ hours: 1 }), until: NOW.add({ hours: 1 }) },
      sink,
      NOW,
    );

    for (const rollup of rollups) {
      expect(JSON.stringify(rollup.summary)).not.toContain(String(USER_ID));
    }
  });

  it('stamps every rollup with computedAt, distinct from the window it covers', async () => {
    const usage = new FakeUsageStore();
    const maintenance = new FakeMaintenanceStore(usage);
    const sink = new InMemoryUsageRollupSink();
    const since = NOW.subtract({ hours: 3 });

    const rollups = await runUsageRollup({ maintenance, usage, globalUsage: usage }, { since, until: NOW }, sink, NOW);
    for (const rollup of rollups) {
      expect(rollup.computedAt.equals(NOW)).toBe(true);
      expect(rollup.summary.since.equals(since)).toBe(true);
    }
  });
});
