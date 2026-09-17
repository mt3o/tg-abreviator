/**
 * `ChunkStore` port conformance.
 *
 * The two rules with teeth (DESIGN §5, §7): the cache key includes `model` and
 * `promptVersion`, and a chunk never outlives the messages it covers.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { asMessageId } from '../../src/domain/model/ids.js';
import type { ChunkStore } from '../../src/application/ports/driven/chunk-store.js';
import type { MessageStore } from '../../src/application/ports/driven/message-store.js';
import {
  CHAT_A,
  CHAT_B,
  FAR_FUTURE,
  FAR_PAST,
  TOPIC_DEPLOYS,
  at,
  makeChunk,
  makeConversation,
} from './support.js';
import type { ConformanceFactory } from './support.js';

/** `deleteExpired` is defined in terms of covered messages, so both stores are needed. */
export interface ChunkStoreBundle {
  readonly chunks: ChunkStore;
  readonly messages: MessageStore;
}

export function runChunkStoreConformance(
  label: string,
  factory: ConformanceFactory<ChunkStoreBundle>,
): void {
  describe(`ChunkStore conformance (${label})`, () => {
    let chunks: ChunkStore;
    let messages: MessageStore;
    let teardown: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const fixture = await factory();
      chunks = fixture.store.chunks;
      messages = fixture.store.messages;
      teardown = fixture.teardown?.bind(fixture);
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('round-trips a chunk', async () => {
      const chunk = makeChunk({ threadId: TOPIC_DEPLOYS, text: 'they agreed to ship on Friday' });
      await chunks.save(CHAT_A, chunk);

      const found = await chunks.find(CHAT_A, chunk);
      expect(found?.text).toBe('they agreed to ship on Friday');
      expect(found?.threadId).toBe(TOPIC_DEPLOYS);
      expect(found?.firstMsgId).toBe(chunk.firstMsgId);
      expect(found?.lastMsgId).toBe(chunk.lastMsgId);
    });

    it('misses when the prompt version or the model changes (DESIGN §7)', async () => {
      const chunk = makeChunk({ promptVersion: 'v1', model: 'claude-haiku-4-5' });
      await chunks.save(CHAT_A, chunk);

      expect(await chunks.find(CHAT_A, { ...chunk, promptVersion: 'v2' })).toBeNull();
      expect(await chunks.find(CHAT_A, { ...chunk, model: 'claude-sonnet-5' })).toBeNull();
      expect(await chunks.find(CHAT_A, chunk)).not.toBeNull();
    });

    it('treats a General-topic chunk and a forum-topic chunk as different keys', async () => {
      const general = makeChunk({ threadId: null, text: 'general' });
      const topic = makeChunk({ threadId: TOPIC_DEPLOYS, text: 'topic' });
      await chunks.save(CHAT_A, general);
      await chunks.save(CHAT_A, topic);

      expect((await chunks.find(CHAT_A, general))?.text).toBe('general');
      expect((await chunks.find(CHAT_A, topic))?.text).toBe('topic');
    });

    it('never serves one chat a chunk from another', async () => {
      const chunk = makeChunk();
      await chunks.save(CHAT_A, chunk);
      expect(await chunks.find(CHAT_B, { ...chunk })).toBeNull();
    });

    it('deletes every chunk overlapping a deleted message (DESIGN §5)', async () => {
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 10 }));
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 11, lastMsgId: 20 }));
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 5, lastMsgId: 25 }));

      // A single message inside two of the three spans.
      const deleted = await chunks.deleteCovering(CHAT_A, [asMessageId(7)]);
      expect(deleted).toBe(2);
      expect(await chunks.find(CHAT_A, makeChunk({ firstMsgId: 11, lastMsgId: 20 }))).not.toBeNull();
    });

    it('expires a chunk with its newest covered message, not with its own age', async () => {
      // Messages 1..5 at T0+1 .. T0+5; the chunk covers all of them.
      await messages.upsertMany(CHAT_A, makeConversation(5));
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 5, createdAt: at(5) }));

      // Cutoff before the newest covered message: the summary may live.
      expect(await chunks.deleteExpired(CHAT_A, at(4))).toBe(0);

      // Cutoff after it: the messages are gone, so the summary must go too.
      expect(await chunks.deleteExpired(CHAT_A, FAR_FUTURE)).toBe(1);
      expect(await chunks.find(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 5 }))).toBeNull();
    });

    it('keeps nothing that covers no surviving message', async () => {
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 100, lastMsgId: 110, createdAt: FAR_PAST }));
      expect(await chunks.deleteExpired(CHAT_A, at(0))).toBe(1);
    });

    it('wipes a chat', async () => {
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 5 }));
      await chunks.save(CHAT_A, makeChunk({ firstMsgId: 6, lastMsgId: 9 }));
      expect(await chunks.deleteChat(CHAT_A)).toBe(2);
      expect(await chunks.find(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 5 }))).toBeNull();
    });
  });
}
