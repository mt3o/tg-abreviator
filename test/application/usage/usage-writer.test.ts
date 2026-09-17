import { describe, expect, it } from 'vitest';

import { recordUsage, zeroPrices } from '../../../src/application/usage/usage-writer.js';
import { hashQuestion } from '../../../src/domain/dedupe.js';
import { asChatId, asThreadId, asUserId } from '../../../src/domain/model/ids.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeIdGenerator } from '../../fakes/fake-id-generator.js';
import { FakeUsageStore } from '../../fakes/fake-usage-store.js';
import type { RecordUsageInput } from '../../../src/application/usage/usage-writer.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const THREAD_ID = asThreadId(7);
const USER_ID = asUserId(111);
const PRICES = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cacheReadPerMTokUsd: 0.3 };

function input(overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
  return {
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
    model: 'claude-sonnet-5',
    phase: 'single',
    inputTokens: 1000,
    outputTokens: 200,
    unitPrices: PRICES,
    rangeSpec: '2h',
    question: null,
    status: 'ok',
    ...overrides,
  };
}

describe('recordUsage', () => {
  it('appends exactly one row to the chat it belongs to', async () => {
    const store = new FakeUsageStore();
    await recordUsage(store, new FakeIdGenerator(), new FakeClock(), input());
    expect(store.dump(CHAT_ID)).toHaveLength(1);
  });

  it('computes costMicros from tokens and the supplied unit prices', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(
      store,
      new FakeIdGenerator(),
      new FakeClock(),
      input({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(event.costMicros).toBe(3_000_000 + 15_000_000);
  });

  it('stores the unit prices in force at write time on the row (DESIGN §4)', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(store, new FakeIdGenerator(), new FakeClock(), input());
    expect(event.unitPrices).toEqual(PRICES);
  });

  it('never stores the question text — only its hash', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(
      store,
      new FakeIdGenerator(),
      new FakeClock(),
      input({ question: 'co ustalili w sprawie budżetu?' }),
    );
    expect(event.questionHash).toBe(hashQuestion('co ustalili w sprawie budżetu?'));
    expect(JSON.stringify(event)).not.toContain('budżetu');
  });

  it('stores a null questionHash for a summarize call (no question)', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(store, new FakeIdGenerator(), new FakeClock(), input({ question: null }));
    expect(event.questionHash).toBeNull();
  });

  it('takes the id from IdGenerator and the timestamp from Clock — never ambient state', async () => {
    const idGenerator = new FakeIdGenerator(7);
    const clock = new FakeClock();
    const event = await recordUsage(new FakeUsageStore(), idGenerator, clock, input());
    expect(event.id).toBe(idGenerator.issued[0]);
    expect(event.ts.equals(clock.now())).toBe(true);
  });

  it('records a real user reference, not yet anonymised', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(store, new FakeIdGenerator(), new FakeClock(), input());
    expect(event.user).toEqual({ kind: 'user', userId: USER_ID });
  });

  it('defaults cacheReadTokens to zero when omitted (DESIGN §7: no caching in v1)', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(
      store,
      new FakeIdGenerator(),
      new FakeClock(),
      input({ inputTokens: 100, outputTokens: 0 }),
    );
    expect(event.costMicros).toBe(300);
  });

  it('carries the phase, model, and rangeSpec through verbatim', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(
      store,
      new FakeIdGenerator(),
      new FakeClock(),
      input({ phase: 'map', model: 'claude-haiku-4-5', rangeSpec: '-500' }),
    );
    expect(event.phase).toBe('map');
    expect(event.model).toBe('claude-haiku-4-5');
    expect(event.rangeSpec).toBe('-500');
  });
});

describe('zeroPrices', () => {
  it('forces cost to zero regardless of token counts', async () => {
    const store = new FakeUsageStore();
    const event = await recordUsage(
      store,
      new FakeIdGenerator(),
      new FakeClock(),
      input({ inputTokens: 999_999, unitPrices: zeroPrices(), status: 'cached' }),
    );
    expect(event.costMicros).toBe(0);
  });
});
