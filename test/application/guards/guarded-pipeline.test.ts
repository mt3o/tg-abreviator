import { describe, expect, it } from 'vitest';

import { GuardedPipeline } from '../../../src/application/guards/guarded-pipeline.js';
import type { GuardCheckInput } from '../../../src/application/guards/guarded-pipeline.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { asChatId, asThreadId, asUsageEventId, asUserId } from '../../../src/domain/model/ids.js';
import { userRef } from '../../../src/domain/model/usage.js';
import type { Answer } from '../../../src/domain/model/answer.js';
import type { UsageEvent } from '../../../src/domain/model/usage.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeErrorReporter } from '../../fakes/fake-error-reporter.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const THREAD_ID = asThreadId(7);
const USER_ID = asUserId(111);
const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');
const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function input(overrides: Partial<GuardCheckInput> = {}): GuardCheckInput {
  return {
    chatId: CHAT_ID,
    userId: USER_ID,
    threadId: THREAD_ID,
    rawRangeToken: '2h',
    question: null,
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    cooldownSeconds: 60,
    concurrentPerChat: 1,
    dailyCallsPerChat: 50,
    dedupeTtlSeconds: 300,
    globalDailyBudgetUsd: 5,
    ...overrides,
  };
}

function fakeAnswer(): Answer {
  return {
    content: { summary: 'they decided X', keyPoints: [], unanswered: [], tone: 'neutral' },
    meta: {
      chatId: CHAT_ID,
      scope: { kind: 'thread', threadId: THREAD_ID },
      topicLabel: null,
      range: {
        scope: { kind: 'thread', threadId: THREAD_ID },
        start: { kind: 'instant', ts: NOW.subtract({ hours: 2 }) },
        end: NOW,
        limit: 500,
        spec: { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
        basis: 'explicit',
        clampedToHorizon: false,
        timeZone: 'Europe/Warsaw',
      },
      spec: { kind: 'duration', raw: '2h', duration: { unit: 'hours', amount: 2 } },
      messageCount: 12,
      gapCount: 0,
      cached: null,
      model: 'claude-sonnet-5',
      promptVersion: 'v1',
    },
  };
}

function usageEvent(costMicros: number, ts = NOW): UsageEvent {
  return {
    id: asUsageEventId(`evt-${String(Math.random())}`),
    ts,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    user: userRef(USER_ID),
    model: 'claude-sonnet-5',
    phase: 'single',
    inputTokens: 100,
    outputTokens: 100,
    costMicros,
    unitPrices: PRICES,
    rangeSpec: '2h',
    questionHash: null,
    status: 'ok',
  };
}

function build() {
  const clock = new FakeClock(NOW);
  const usage = new FakeUsageStore();
  const errorReporter = new FakeErrorReporter();
  const pipeline = new GuardedPipeline({ clock, usage, globalUsage: usage, errorReporter });
  return { clock, usage, errorReporter, pipeline };
}

describe('GuardedPipeline.begin', () => {
  it('proceeds on a fresh, unguarded call', async () => {
    const { pipeline } = build();
    expect(await pipeline.begin(input())).toEqual({ kind: 'proceed' });
  });

  it('refuses a second call from the same user inside the cooldown window', async () => {
    const { pipeline } = build();
    await pipeline.begin(input());
    const decision = await pipeline.begin(input());
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.code).toBe('guard.cooldown');
  });

  it('refuses a second concurrent call for the same chat while one is in flight', async () => {
    const { pipeline } = build();
    await pipeline.begin(input({ userId: asUserId(1) }));
    const decision = await pipeline.begin(input({ userId: asUserId(2), cooldownSeconds: 0 }));
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.code).toBe('guard.concurrent_request');
  });

  it('allows a new, distinct call once the in-flight one completes', async () => {
    const { pipeline } = build();
    const first = input({ userId: asUserId(1) });
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());
    // A different range token: not a dedupe hit, so this exercises the
    // concurrency slot actually having been released rather than a cache hit.
    const decision = await pipeline.begin(
      input({ userId: asUserId(2), cooldownSeconds: 0, rawRangeToken: '1w' }),
    );
    expect(decision.kind).toBe('proceed');
  });

  it('refuses once the chat has hit its daily call cap', async () => {
    const { usage, pipeline } = build();
    for (let i = 0; i < 5; i += 1) {
      await usage.record(CHAT_ID, usageEvent(1000));
    }
    const decision = await pipeline.begin(input({ dailyCallsPerChat: 5 }));
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.code).toBe('guard.daily_cap');
  });

  it('is a hard stop: refuses every call once the global budget is exhausted', async () => {
    const { usage, pipeline } = build();
    await usage.record(CHAT_ID, usageEvent(5_000_000));
    const decision = await pipeline.begin(input({ globalDailyBudgetUsd: 5 }));
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.code).toBe('guard.budget_exhausted');
  });

  it('reports the budget trip to the error sink (DESIGN §11)', async () => {
    const { usage, errorReporter, pipeline } = build();
    await usage.record(CHAT_ID, usageEvent(5_000_000));
    await pipeline.begin(input({ globalDailyBudgetUsd: 5 }));
    expect(errorReporter.events.some((e) => e.context.errorCode === 'guard.budget_exhausted')).toBe(true);
  });

  it('does not report a daily-cap refusal (report: false, DESIGN §11 metrics not incidents)', async () => {
    const { usage, errorReporter, pipeline } = build();
    for (let i = 0; i < 5; i += 1) await usage.record(CHAT_ID, usageEvent(1000));
    await pipeline.begin(input({ dailyCallsPerChat: 5 }));
    expect(errorReporter.events).toHaveLength(0);
  });

  it('releases the concurrency slot when the daily cap trips, so it does not leak', async () => {
    const { usage, pipeline } = build();
    for (let i = 0; i < 5; i += 1) await usage.record(CHAT_ID, usageEvent(1000));
    await pipeline.begin(input({ dailyCallsPerChat: 5, cooldownSeconds: 0 }));
    expect(pipeline.concurrency.inFlightCount(CHAT_ID)).toBe(0);
  });

  it('serves a repeat identical request from the dedupe cache instead of proceeding', async () => {
    const { pipeline } = build();
    const first = input();
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    const decision = await pipeline.begin(input({ userId: asUserId(2), cooldownSeconds: 0 }));
    expect(decision.kind).toBe('cached');
  });

  it('a dedupe hit never touches the concurrency slot', async () => {
    const { pipeline } = build();
    const first = input();
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    await pipeline.begin(input({ userId: asUserId(2), cooldownSeconds: 0 }));
    expect(pipeline.concurrency.inFlightCount(CHAT_ID)).toBe(0);
  });

  it('does not dedupe-hit for the same resolved window reached via a different raw range token', async () => {
    // DESIGN §9: keyed on the raw token, not the resolved window — '2h' and a
    // literal duration spec that happens to cover the same wall-clock range
    // must not collide just because their raw tokens differ.
    const { pipeline } = build();
    const first = input({ rawRangeToken: '2h' });
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    const decision = await pipeline.begin(
      input({ userId: asUserId(2), cooldownSeconds: 0, rawRangeToken: '120m' }),
    );
    expect(decision.kind).toBe('proceed');
  });

  it('does dedupe-hit for a byte-identical resend of the same raw range token', async () => {
    const { pipeline } = build();
    const first = input({ rawRangeToken: '-50' });
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    const decision = await pipeline.begin(
      input({ userId: asUserId(2), cooldownSeconds: 0, rawRangeToken: '-50' }),
    );
    expect(decision.kind).toBe('cached');
  });

  it('a dedupe hit reports the cached answer’s age in minutes', async () => {
    const { clock, pipeline } = build();
    const first = input();
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    clock.advance({ minutes: 3 });
    const decision = await pipeline.begin(input({ userId: asUserId(2), cooldownSeconds: 0 }));
    expect(decision.kind === 'cached' && decision.ageMinutes).toBe(3);
  });

  it('a dedupe entry expires after its TTL', async () => {
    const { clock, pipeline } = build();
    const first = input({ dedupeTtlSeconds: 300 });
    await pipeline.begin(first);
    pipeline.complete(first, fakeAnswer());

    clock.advance({ minutes: 6 });
    const decision = await pipeline.begin(
      input({ userId: asUserId(2), cooldownSeconds: 0, dedupeTtlSeconds: 300 }),
    );
    expect(decision.kind).toBe('proceed');
  });
});

describe('GuardedPipeline.complete', () => {
  it('releases the concurrency slot without caching when the call did not produce an answer', async () => {
    const { pipeline } = build();
    const first = input();
    await pipeline.begin(first);
    pipeline.complete(first, null);

    expect(pipeline.concurrency.inFlightCount(CHAT_ID)).toBe(0);
    const decision = await pipeline.begin(
      input({ userId: asUserId(2), cooldownSeconds: 0 }),
    );
    expect(decision.kind).toBe('proceed');
  });
});
