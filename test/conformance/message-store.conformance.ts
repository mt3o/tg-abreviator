/**
 * `MessageStore` port conformance.
 *
 * Implementation-agnostic on purpose: WS1 runs this exact suite against the
 * SQLite adapter (`runMessageStoreConformance('sqlite', …)`). If the fake and
 * the real store disagree about ordering, about what `countInRange` counts, or
 * about whether a chat can see another chat's rows, this is where it surfaces —
 * before a summary of the wrong group's messages does.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { AnchorNotFoundError } from '../../src/domain/errors.js';
import { asMessageId } from '../../src/domain/model/ids.js';
import { NON_HUMAN_MESSAGE_KINDS } from '../../src/domain/model/message.js';
import type { MessageStore } from '../../src/application/ports/driven/message-store.js';
import {
  ALL_SCOPE,
  CHAT_A,
  CHAT_B,
  FAR_FUTURE,
  TOPIC_DEPLOYS,
  TOPIC_RANDOM,
  USER_ALA,
  USER_OLA,
  at,
  lastN,
  makeConversation,
  makeMessage,
  sinceInstant,
  sinceMessage,
  makeRange,
} from './support.js';
import type { ConformanceFactory } from './support.js';

export function runMessageStoreConformance(
  label: string,
  factory: ConformanceFactory<MessageStore>,
): void {
  describe(`MessageStore conformance (${label})`, () => {
    let store: MessageStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      store = fixture.store;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('round-trips every field', async () => {
      const message = makeMessage({
        messageId: 5,
        threadId: TOPIC_DEPLOYS,
        userId: USER_OLA,
        displayName: 'Ola',
        replyToMessageId: asMessageId(3),
        kind: 'photo',
        text: 'a caption, never the file',
      });
      await store.upsert(CHAT_A, message);

      const found = await store.findById(CHAT_A, asMessageId(5));
      expect(found).not.toBeNull();
      expect(found?.chatId).toBe(CHAT_A);
      expect(found?.messageId).toBe(message.messageId);
      expect(found?.threadId).toBe(TOPIC_DEPLOYS);
      expect(found?.userId).toBe(USER_OLA);
      expect(found?.displayName).toBe('Ola');
      expect(found?.replyToMessageId).toBe(asMessageId(3));
      expect(found?.kind).toBe('photo');
      expect(found?.text).toBe('a caption, never the file');
      expect(found?.ts.epochMilliseconds).toBe(message.ts.epochMilliseconds);
    });

    it('rejects a message that belongs to a different chat (DESIGN §6.1)', async () => {
      const foreign = makeMessage({ chatId: CHAT_B, messageId: 1 });
      await expect(store.upsert(CHAT_A, foreign)).rejects.toThrow();
    });

    it('is idempotent on (chat_id, message_id) and edits in place', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, text: 'original' }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, text: 'original' }));
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(1);

      await store.upsert(CHAT_A, makeMessage({ messageId: 1, text: 'edited' }));
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(1);
      expect((await store.findById(CHAT_A, asMessageId(1)))?.text).toBe('edited');
    });

    it('never lets one chat see another chat\'s rows', async () => {
      await store.upsertMany(CHAT_A, makeConversation(3));
      await store.upsertMany(CHAT_B, makeConversation(3, { chatId: CHAT_B }));

      await store.deleteChat(CHAT_B);

      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(3);
      expect(await store.countAll(CHAT_B, ALL_SCOPE)).toBe(0);
      expect(await store.findById(CHAT_B, asMessageId(1))).toBeNull();
      expect(await store.findById(CHAT_A, asMessageId(1))).not.toBeNull();
    });

    it('scopes to a thread, and `all` crosses topics', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, threadId: TOPIC_DEPLOYS }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 2, threadId: TOPIC_RANDOM }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 3, threadId: null }));

      const deploys = await store.fetchRange(
        CHAT_A,
        sinceInstant(at(0), { scope: { kind: 'thread', threadId: TOPIC_DEPLOYS } }),
      );
      expect(deploys.map((m) => m.messageId)).toEqual([asMessageId(1)]);

      const general = await store.fetchRange(
        CHAT_A,
        sinceInstant(at(0), { scope: { kind: 'thread', threadId: null } }),
      );
      expect(general.map((m) => m.messageId)).toEqual([asMessageId(3)]);

      const all = await store.fetchRange(CHAT_A, sinceInstant(at(0), { scope: ALL_SCOPE }));
      expect(all).toHaveLength(3);
    });

    it('orders by (ts, messageId), so a synthetic gap marker lands in its real place', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, ts: at(1) }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 2, ts: at(3) }));
      const marker = await store.insertGapMarker(CHAT_A, {
        threadId: null,
        ts: at(2),
        text: null,
      });

      expect(marker.messageId).toBeLessThan(0);
      expect(marker.kind).toBe('gap_marker');

      const rows = await store.fetchRange(CHAT_A, sinceInstant(at(0)));
      expect(rows.map((m) => m.ts.epochMilliseconds)).toEqual([
        at(1).epochMilliseconds,
        at(2).epochMilliseconds,
        at(3).epochMilliseconds,
      ]);
      expect(rows[1]?.messageId).toBe(marker.messageId);
    });

    it('filters by instant', async () => {
      await store.upsertMany(CHAT_A, makeConversation(5));
      const rows = await store.fetchRange(CHAT_A, sinceInstant(at(3)));
      expect(rows.map((m) => m.messageId)).toEqual([3, 4, 5].map(asMessageId));

      const capped = await store.fetchRange(
        CHAT_A,
        sinceInstant(at(0), { end: at(2) }),
      );
      expect(capped.map((m) => m.messageId)).toEqual([1, 2].map(asMessageId));
    });

    it('anchors on a message, inclusively or not', async () => {
      await store.upsertMany(CHAT_A, makeConversation(5));

      const inclusive = await store.fetchRange(CHAT_A, sinceMessage(asMessageId(3), true));
      expect(inclusive.map((m) => m.messageId)).toEqual([3, 4, 5].map(asMessageId));

      const exclusive = await store.fetchRange(CHAT_A, sinceMessage(asMessageId(3), false));
      expect(exclusive.map((m) => m.messageId)).toEqual([4, 5].map(asMessageId));
    });

    it('refuses to guess when the anchor is not stored', async () => {
      await store.upsertMany(CHAT_A, makeConversation(2));
      await expect(
        store.fetchRange(CHAT_A, sinceMessage(asMessageId(99), true)),
      ).rejects.toBeInstanceOf(AnchorNotFoundError);
    });

    it('takes the newest N for a `-N` range', async () => {
      await store.upsertMany(CHAT_A, makeConversation(10));
      const rows = await store.fetchRange(CHAT_A, lastN(3));
      expect(rows.map((m) => m.messageId)).toEqual([8, 9, 10].map(asMessageId));
    });

    it('keeps the newest rows when the limit bites', async () => {
      await store.upsertMany(CHAT_A, makeConversation(10));
      const rows = await store.fetchRange(CHAT_A, sinceInstant(at(0), { limit: 4 }));
      expect(rows.map((m) => m.messageId)).toEqual([7, 8, 9, 10].map(asMessageId));
    });

    it('counts the true size of the range, ignoring the limit', async () => {
      await store.upsertMany(CHAT_A, makeConversation(10));

      expect(await store.countInRange(CHAT_A, sinceInstant(at(0), { limit: 4 }))).toBe(10);
      expect(await store.countInRange(CHAT_A, lastN(3))).toBe(3);
      expect(await store.countInRange(CHAT_A, sinceInstant(at(6)))).toBe(5);
      expect(await store.countInRange(CHAT_B, sinceInstant(at(0)))).toBe(0);
    });

    it('filters opted-out users and non-human kinds at query time (DESIGN §6.3)', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, userId: USER_ALA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 2, userId: USER_OLA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 3, userId: null, kind: 'service' }));

      const filtered = await store.fetchRange(CHAT_A, sinceInstant(at(0)), {
        excludeUserIds: [USER_OLA],
        excludeKinds: NON_HUMAN_MESSAGE_KINDS,
      });
      expect(filtered.map((m) => m.messageId)).toEqual([asMessageId(1)]);

      const counted = await store.countInRange(CHAT_A, sinceInstant(at(0)), {
        excludeUserIds: [USER_OLA],
        excludeKinds: NON_HUMAN_MESSAGE_KINDS,
      });
      expect(counted).toBe(1);
    });

    it('applies the filters before the `-N` count, so -N means N visible messages', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, userId: USER_ALA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 2, userId: USER_OLA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 3, userId: USER_ALA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 4, userId: USER_OLA }));

      const rows = await store.fetchRange(CHAT_A, lastN(2), { excludeUserIds: [USER_OLA] });
      expect(rows.map((m) => m.messageId)).toEqual([1, 3].map(asMessageId));
    });

    it('reports the corpus horizon and the newest row', async () => {
      expect(await store.oldest(CHAT_A, ALL_SCOPE)).toBeNull();
      expect(await store.newest(CHAT_A, ALL_SCOPE)).toBeNull();

      await store.upsertMany(CHAT_A, makeConversation(4));
      expect((await store.oldest(CHAT_A, ALL_SCOPE))?.messageId).toBe(asMessageId(1));
      expect((await store.newest(CHAT_A, ALL_SCOPE))?.messageId).toBe(asMessageId(4));
    });

    it('deletes one user\'s rows and reports their ids for the chunk cascade', async () => {
      await store.upsert(CHAT_A, makeMessage({ messageId: 1, userId: USER_ALA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 2, userId: USER_OLA }));
      await store.upsert(CHAT_A, makeMessage({ messageId: 3, userId: USER_OLA }));
      await store.upsert(CHAT_B, makeMessage({ chatId: CHAT_B, messageId: 4, userId: USER_OLA }));

      const deleted = await store.deleteByUser(CHAT_A, USER_OLA);
      expect([...deleted].sort((a, b) => a - b)).toEqual([2, 3].map(asMessageId));
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(1);
      // The same person in another chat is a different row set.
      expect(await store.countAll(CHAT_B, ALL_SCOPE)).toBe(1);
    });

    it('sweeps by timestamp', async () => {
      await store.upsertMany(CHAT_A, makeConversation(5));
      expect(await store.deleteOlderThan(CHAT_A, at(3))).toBe(2);
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(3);
      expect(await store.deleteOlderThan(CHAT_A, FAR_FUTURE)).toBe(3);
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(0);
    });

    it('wipes a chat', async () => {
      await store.upsertMany(CHAT_A, makeConversation(3));
      expect(await store.deleteChat(CHAT_A)).toBe(3);
      expect(await store.countAll(CHAT_A, ALL_SCOPE)).toBe(0);
      expect(
        await store.fetchRange(CHAT_A, makeRange({ kind: 'lastN', count: 100 })),
      ).toHaveLength(0);
    });
  });
}
