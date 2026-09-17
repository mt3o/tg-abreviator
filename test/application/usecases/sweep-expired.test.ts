/**
 * The TTL sweeper (DESIGN §5, §11).
 *
 * "Rolling TTL. Global default 30d, per-chat override in config, hard cap in
 * env. Nothing can set 'forever' without a redeploy." These are the tests that
 * make that sentence true rather than aspirational.
 */
import { describe, expect, it } from 'vitest';

import { SweepExpiredUseCase } from '../../../src/application/usecases/sweep-expired.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { createFakeStores } from '../../fakes/create-fake-stores.js';
import { FakeClock } from '../../fakes/fake-clock.js';
import { FakeConfig, TEST_FILE_LAYER } from '../../fakes/fake-config.js';
import type { Plain } from '../../fakes/fake-config.js';
import { CHAT_A, CHAT_B, USER_ALA, makeChunk, makeMessage, makeUsageEvent } from '../../conformance/support.js';

const NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

function daysAgo(days: number): Temporal.Instant {
  return NOW.subtract({ hours: days * 24 });
}

function makeCase(retention: Plain = {}) {
  const clock = new FakeClock(NOW);
  const stores = createFakeStores({ clock });
  const config = new FakeConfig({
    file: { ...TEST_FILE_LAYER, retention } as never,
  });
  const useCase = new SweepExpiredUseCase({
    maintenance: stores.maintenance,
    messages: stores.messages,
    chunks: stores.chunks,
    usage: stores.usage,
    pseudonyms: stores.pseudonyms,
    config,
    clock,
  });
  return { ...stores, clock, config, useCase };
}

describe('SweepExpiredUseCase', () => {
  it('deletes what is past the TTL and keeps what is inside it', async () => {
    const c = makeCase();
    await c.messages.upsertMany(CHAT_A, [
      makeMessage({ messageId: 1, ts: daysAgo(40), text: 'ancient' }),
      makeMessage({ messageId: 2, ts: daysAgo(31), text: 'just past' }),
      makeMessage({ messageId: 3, ts: daysAgo(29), text: 'just inside' }),
      makeMessage({ messageId: 4, ts: daysAgo(1), text: 'fresh' }),
    ]);

    const result = await c.useCase.execute();

    expect(result.messagesDeleted).toBe(2);
    expect(c.messages.dump(CHAT_A).map((row) => row.text)).toEqual(['just inside', 'fresh']);
  });

  it('never lets a cached chunk outlive the messages it summarizes', async () => {
    const c = makeCase();
    await c.messages.upsertMany(CHAT_A, [
      makeMessage({ messageId: 1, ts: daysAgo(40) }),
      makeMessage({ messageId: 2, ts: daysAgo(35) }),
      makeMessage({ messageId: 10, ts: daysAgo(2) }),
      makeMessage({ messageId: 11, ts: daysAgo(1) }),
    ]);
    await c.chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 2 }));
    await c.chunks.save(CHAT_A, makeChunk({ firstMsgId: 10, lastMsgId: 11 }));

    const result = await c.useCase.execute();

    // The old chunk goes with its messages; the recent one stays.
    expect(result.chunksDeleted).toBe(1);
    const key = { threadId: null, model: 'claude-haiku-4-5', promptVersion: 'v1' };
    expect(await c.chunks.find(CHAT_A, { ...key, firstMsgId: makeMessage({ messageId: 1 }).messageId, lastMsgId: makeMessage({ messageId: 2 }).messageId })).toBeNull();
    expect(await c.chunks.find(CHAT_A, { ...key, firstMsgId: makeMessage({ messageId: 10 }).messageId, lastMsgId: makeMessage({ messageId: 11 }).messageId })).not.toBeNull();
  });

  it('expires usage events and pseudonyms on the same schedule as messages', async () => {
    const c = makeCase();
    await c.messages.upsert(CHAT_A, makeMessage({ messageId: 1, ts: daysAgo(40) }));
    await c.usage.record(CHAT_A, makeUsageEvent({ id: 'old', ts: daysAgo(40) }));
    await c.usage.record(CHAT_A, makeUsageEvent({ id: 'new', ts: daysAgo(1) }));
    // The label's own age is what expires it, so it has to have been
    // allocated back then — not in this test's "now".
    c.clock.set(daysAgo(40));
    await c.pseudonyms.labelFor(CHAT_A, USER_ALA);
    c.clock.set(NOW);

    const result = await c.useCase.execute();

    // DESIGN §4: `usage_events` gets the same TTL as messages.
    expect(result.usageRowsDeleted).toBe(1);
    expect(c.usage.dump(CHAT_A).map((event) => event.id)).toEqual(['new']);
    // DESIGN §11: the label stops resolving once the data behind it is gone.
    expect(result.pseudonymsDeleted).toBe(1);
    expect(await c.pseudonyms.peek(CHAT_A, USER_ALA)).toBeNull();
  });

  it('honours a per-chat override, chat by chat', async () => {
    const c = makeCase({ perChatTtlDays: { [String(CHAT_A)]: 7 } });
    await c.messages.upsert(CHAT_A, makeMessage({ chatId: CHAT_A, messageId: 1, ts: daysAgo(10) }));
    await c.messages.upsert(CHAT_B, makeMessage({ chatId: CHAT_B, messageId: 1, ts: daysAgo(10) }));

    const result = await c.useCase.execute();

    expect(result.chatsSwept).toBe(2);
    expect(c.messages.dump(CHAT_A)).toHaveLength(0);
    expect(c.messages.dump(CHAT_B)).toHaveLength(1);
  });

  it('clamps a per-chat override to the hard cap: nothing can set "forever"', async () => {
    // DESIGN §5: the hard cap is the env-side ceiling. A file that asks for a
    // year of retention gets the cap, not the year.
    const c = makeCase({ ttlDays: 365, hardCapDays: 30, perChatTtlDays: { [String(CHAT_A)]: 365 } });
    await c.messages.upsert(CHAT_A, makeMessage({ messageId: 1, ts: daysAgo(40) }));

    await c.useCase.execute();

    expect(c.messages.dump(CHAT_A)).toHaveLength(0);
  });

  it('is a no-op on an empty deployment', async () => {
    const c = makeCase();
    expect(await c.useCase.execute()).toEqual({
      chatsSwept: 0,
      messagesDeleted: 0,
      chunksDeleted: 0,
      usageRowsDeleted: 0,
      pseudonymsDeleted: 0,
    });
  });
});
