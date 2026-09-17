/**
 * `bucketByTime`, `groupByWeight`, `partitionByKey` (DESIGN §7 "Compaction",
 * WS11 DoD).
 *
 * The determinism test is the one the DoD names explicitly: "the same range
 * computed twice, with a new message arriving in between, yields identical
 * boundaries for all completed buckets."
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUCKET_HOURS,
  bucketByTime,
  groupByWeight,
  partitionByKey,
} from '../../src/domain/buckets.js';
import { InvalidValueError } from '../../src/domain/errors.js';
import { asChatId, asMessageId, asThreadId, asUserId } from '../../src/domain/model/ids.js';
import { Temporal } from '../../src/domain/time/temporal.js';
import type { StoredMessage } from '../../src/domain/model/message.js';

const CHAT = asChatId(-1001);
const USER = asUserId(555);
const ZONE = 'Europe/Warsaw';

function message(id: number, iso: string, text = `m${String(id)}`): StoredMessage {
  return {
    chatId: CHAT,
    messageId: asMessageId(id),
    threadId: null,
    userId: USER,
    displayName: 'Ola',
    ts: Temporal.Instant.from(iso),
    replyToMessageId: null,
    kind: 'text',
    text,
  };
}

describe('bucketByTime', () => {
  it('empty input yields no buckets', () => {
    expect(bucketByTime([], { timeZone: ZONE })).toEqual([]);
  });

  it('defaults to a 6h grid: 08:00Z (10:00 Warsaw) lands in the [06:00,12:00) slot', () => {
    const messages = [message(1, '2026-09-17T08:00:00Z')];
    const [bucket] = bucketByTime(messages, { timeZone: ZONE });
    expect(bucket).toBeDefined();
    expect(bucket?.start.hour).toBe(6);
    expect(bucket?.end.hour).toBe(12);
  });

  it('groups messages sharing a bucket and separates messages in different buckets', () => {
    // Warsaw is UTC+2 in September (no DST transition involved here).
    const messages = [
      message(1, '2026-09-17T07:05:00Z'), // 09:05 local -> bucket [06:00,12:00)
      message(2, '2026-09-17T09:00:00Z'), // 11:00 local -> same bucket
      message(3, '2026-09-17T11:30:00Z'), // 13:30 local -> bucket [12:00,18:00)
    ];
    const buckets = bucketByTime(messages, { timeZone: ZONE });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.messages.map((m) => m.messageId)).toEqual([asMessageId(1), asMessageId(2)]);
    expect(buckets[1]?.messages.map((m) => m.messageId)).toEqual([asMessageId(3)]);
    expect(buckets[0]?.start.toString()).toBe('2026-09-17T06:00:00+02:00[Europe/Warsaw]');
    expect(buckets[0]?.end.toString()).toBe('2026-09-17T12:00:00+02:00[Europe/Warsaw]');
  });

  it('accepts unsorted input and returns buckets in chronological order', () => {
    const messages = [
      message(3, '2026-09-17T11:30:00Z'),
      message(1, '2026-09-17T07:05:00Z'),
      message(2, '2026-09-17T09:00:00Z'),
    ];
    const buckets = bucketByTime(messages, { timeZone: ZONE });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.messages.map((m) => m.messageId)).toEqual([asMessageId(1), asMessageId(2)]);
  });

  it('rejects a bucketHours that does not evenly divide 24', () => {
    expect(() => bucketByTime([message(1, '2026-09-17T07:00:00Z')], { timeZone: ZONE, bucketHours: 5 })).toThrow(
      InvalidValueError,
    );
  });

  it('honors a custom bucketHours', () => {
    // 2026-09-16T22:30:00Z = 2026-09-17T00:30:00 Warsaw (UTC+2 in September).
    const messages = [message(1, '2026-09-16T22:30:00Z')];
    const buckets = bucketByTime(messages, { timeZone: ZONE, bucketHours: 12 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.start.hour).toBe(0);
    expect(buckets[0]?.end.hour).toBe(12);
  });

  it('handles the Europe/Warsaw autumn DST fall-back (2026-10-25) without throwing', () => {
    const messages = [
      message(1, '2026-10-24T22:00:00Z'), // 2026-10-25 00:00 CEST (+02:00)
      message(2, '2026-10-25T02:00:00Z'), // 2026-10-25 04:00 CET (+01:00), after the fold
    ];
    const buckets = bucketByTime(messages, { timeZone: ZONE });
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      expect(Temporal.ZonedDateTime.compare(bucket.end, bucket.start)).toBeGreaterThan(0);
    }
  });

  describe('determinism (WS11 DoD)', () => {
    it('a message arriving later never reshapes an already-completed bucket', () => {
      const base = [
        message(1, '2026-09-17T07:05:00Z'), // bucket [06:00,12:00)
        message(2, '2026-09-17T09:00:00Z'), // same bucket
      ];
      const firstRun = bucketByTime(base, { timeZone: ZONE });
      expect(firstRun).toHaveLength(1);
      const completedBucket = firstRun[0];
      expect(completedBucket).toBeDefined();

      // A new message arrives later, in a strictly later bucket.
      const withNewArrival = [...base, message(3, '2026-09-18T09:00:00Z')];
      const secondRun = bucketByTime(withNewArrival, { timeZone: ZONE });

      const stillThere = secondRun.find(
        (bucket) => Temporal.ZonedDateTime.compare(bucket.start, completedBucket!.start) === 0,
      );
      expect(stillThere).toBeDefined();
      expect(stillThere?.start.toString()).toBe(completedBucket?.start.toString());
      expect(stillThere?.end.toString()).toBe(completedBucket?.end.toString());
      expect(stillThere?.messages.map((m) => m.messageId)).toEqual(
        completedBucket?.messages.map((m) => m.messageId),
      );
    });

    it('computing the same set twice yields byte-identical boundaries', () => {
      const messages = [
        message(1, '2026-09-17T07:05:00Z'),
        message(2, '2026-09-17T13:00:00Z'),
        message(3, '2026-09-18T02:00:00Z'),
      ];
      const first = bucketByTime(messages, { timeZone: ZONE });
      const second = bucketByTime([...messages].reverse(), { timeZone: ZONE });
      expect(second.map((b) => [b.start.toString(), b.end.toString(), b.messages.map((m) => m.messageId)])).toEqual(
        first.map((b) => [b.start.toString(), b.end.toString(), b.messages.map((m) => m.messageId)]),
      );
    });
  });
});

describe('groupByWeight', () => {
  it('empty input yields no groups', () => {
    expect(groupByWeight<number>([], (x) => x, 10)).toEqual([]);
  });

  it('packs items greedily without exceeding maxWeight', () => {
    const items = [3, 4, 3, 5, 1];
    const groups = groupByWeight(items, (x) => x, 8);
    // 3+4=7 (adding 3 would be 10>8) -> [3,4]; 3+5=8 -> [3,5]; [1]
    expect(groups).toEqual([[3, 4], [3, 5], [1]]);
  });

  it('an item heavier than maxWeight still gets its own group, and the function still terminates', () => {
    const groups = groupByWeight([20, 1, 1], (x) => x, 5);
    expect(groups).toEqual([[20], [1, 1]]);
  });

  it('preserves item order within and across groups', () => {
    const items = ['a', 'b', 'c', 'd'];
    const groups = groupByWeight(items, () => 1, 2);
    expect(groups).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('rejects a non-positive maxWeight', () => {
    expect(() => groupByWeight([1], (x) => x, 0)).toThrow(InvalidValueError);
  });
});

describe('partitionByKey', () => {
  it('empty input yields no groups', () => {
    expect(partitionByKey<number>([], (x) => String(x))).toEqual([]);
  });

  it('groups by key, preserving first-seen order and internal order', () => {
    const items = [
      { id: 1, thread: 'a' },
      { id: 2, thread: 'b' },
      { id: 3, thread: 'a' },
      { id: 4, thread: 'c' },
      { id: 5, thread: 'b' },
    ];
    const groups = partitionByKey(items, (x) => x.thread);
    expect(groups).toEqual([
      [
        { id: 1, thread: 'a' },
        { id: 3, thread: 'a' },
      ],
      [
        { id: 2, thread: 'b' },
        { id: 5, thread: 'b' },
      ],
      [{ id: 4, thread: 'c' }],
    ]);
  });

  it('can key by threadId, distinguishing General (null) from real topics', () => {
    const general1 = message(1, '2026-09-17T07:05:00Z');
    const general2 = message(2, '2026-09-17T08:05:00Z');
    const topic: StoredMessage = { ...message(3, '2026-09-17T09:05:00Z'), threadId: asThreadId(42) };
    const groups = partitionByKey([general1, topic, general2], (m) => String(m.threadId ?? 'null'));
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((m) => m.messageId)).toEqual([asMessageId(1), asMessageId(2)]);
    expect(groups[1]?.map((m) => m.messageId)).toEqual([asMessageId(3)]);
  });
});

describe('DEFAULT_BUCKET_HOURS', () => {
  it('is 6, per DESIGN §7', () => {
    expect(DEFAULT_BUCKET_HOURS).toBe(6);
  });
});
