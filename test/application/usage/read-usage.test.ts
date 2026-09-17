import { describe, expect, it } from 'vitest';

import { ReadUsageUseCase } from '../../../src/application/usage/read-usage.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { asChatId, asUsageEventId, asUserId } from '../../../src/domain/model/ids.js';
import { userRef } from '../../../src/domain/model/usage.js';
import type { UsageEvent } from '../../../src/domain/model/usage.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeConfig } from '../../fakes/fake-config.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const OTHER_CHAT = asChatId(-2);
const USER_ID = asUserId(111);
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function event(chatId: typeof CHAT_ID, costMicros: number, ts = NOW): UsageEvent {
  return {
    id: asUsageEventId(`evt-${String(Math.random())}`),
    ts,
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

function build(configOverrides: Partial<{ globalDailyBudgetUsd: number }> = {}) {
  const usage = new FakeUsageStore();
  const clock = new FakeClock(NOW);
  const config = new FakeConfig({
    file: {
      telegram: { allowlist: [-1_000_000_000_001] },
      bot: { operatorContact: '@test' },
      guards: { globalDailyBudgetUsd: configOverrides.globalDailyBudgetUsd ?? 5 },
    },
  });
  const useCase = new ReadUsageUseCase({ usage, globalUsage: usage, config, clock });
  return { usage, clock, config, useCase };
}

describe('ReadUsageUseCase', () => {
  it('summarizes a single chat for scope "chat"', async () => {
    const { usage, useCase } = build();
    await usage.record(CHAT_ID, event(CHAT_ID, 1_000_000));
    await usage.record(OTHER_CHAT, event(OTHER_CHAT, 9_999_999));

    const result = await useCase.execute({
      scope: { kind: 'chat', chatId: CHAT_ID },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });

    expect(result.summary.calls).toBe(1);
    expect(result.summary.costMicros).toBe(1_000_000);
  });

  it('aggregates across every chat for scope "global", carrying no per-chat breakdown', async () => {
    const { usage, useCase } = build();
    await usage.record(CHAT_ID, event(CHAT_ID, 1_000_000));
    await usage.record(OTHER_CHAT, event(OTHER_CHAT, 2_000_000));

    const result = await useCase.execute({
      scope: { kind: 'global' },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });

    expect(result.summary.calls).toBe(2);
    expect(result.summary.costMicros).toBe(3_000_000);
  });

  it('reports full budget headroom when nothing has been spent today', async () => {
    const { useCase } = build({ globalDailyBudgetUsd: 5 });
    const result = await useCase.execute({
      scope: { kind: 'global' },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });
    expect(result.budgetRemainingMicros).toBe(5_000_000);
  });

  it('reduces budget headroom by today’s global spend', async () => {
    const { usage, useCase } = build({ globalDailyBudgetUsd: 5 });
    await usage.record(CHAT_ID, event(CHAT_ID, 2_000_000, NOW));

    const result = await useCase.execute({
      scope: { kind: 'chat', chatId: CHAT_ID },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });
    expect(result.budgetRemainingMicros).toBe(3_000_000);
  });

  it('goes negative once spend exceeds the budget, rather than floor at zero silently', async () => {
    const { usage, useCase } = build({ globalDailyBudgetUsd: 1 });
    await usage.record(CHAT_ID, event(CHAT_ID, 2_000_000, NOW));

    const result = await useCase.execute({
      scope: { kind: 'global' },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });
    expect(result.budgetRemainingMicros).toBe(-1_000_000);
  });

  it('ignores yesterday’s spend when computing today’s headroom', async () => {
    const { usage, useCase } = build({ globalDailyBudgetUsd: 5 });
    await usage.record(CHAT_ID, event(CHAT_ID, 5_000_000, NOW.subtract({ hours: 13 })));

    const result = await useCase.execute({
      scope: { kind: 'global' },
      since: NOW.subtract({ hours: 48 }),
      until: NOW,
      requestedBy: USER_ID,
    });
    expect(result.budgetRemainingMicros).toBe(5_000_000);
  });

  it('echoes the requested scope back on the result', async () => {
    const { useCase } = build();
    const result = await useCase.execute({
      scope: { kind: 'chat', chatId: CHAT_ID },
      since: NOW.subtract({ hours: 1 }),
      until: NOW,
      requestedBy: USER_ID,
    });
    expect(result.scope).toEqual({ kind: 'chat', chatId: CHAT_ID });
  });
});
