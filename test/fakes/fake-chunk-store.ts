/**
 * In-memory `ChunkStore`.
 *
 * The two rules that matter are implemented literally: the cache key includes
 * `model` and `promptVersion`, and `deleteExpired` keys off the chunk's
 * **newest covered message**, which it can only know by asking the message
 * store. That coupling is real — SQLite does it with a join — so the fake takes
 * the message store as a collaborator rather than pretending the question is
 * answerable from `createdAt`.
 */
import { Temporal } from '../../src/domain/time/temporal.js';
import { chunkCovers } from '../../src/domain/model/chunk.js';
import type { Chunk, ChunkKey } from '../../src/domain/model/chunk.js';
import type { ChatId, MessageId } from '../../src/domain/model/ids.js';
import type { ChunkStore } from '../../src/application/ports/driven/chunk-store.js';
import type { FakeMessageStore } from './fake-message-store.js';

function keyOf(key: ChunkKey): string {
  return JSON.stringify([
    key.threadId ?? -1,
    key.firstMsgId,
    key.lastMsgId,
    key.model,
    key.promptVersion,
  ]);
}

export class FakeChunkStore implements ChunkStore {
  readonly #rows = new Map<ChatId, Map<string, Chunk>>();

  /**
   * `messages` is optional: without it, `deleteExpired` falls back to the
   * chunk's own `createdAt`, which is enough for tests that never delete
   * messages and honest about being a fallback.
   */
  constructor(private readonly messages?: FakeMessageStore) {}

  async find(chatId: ChatId, key: ChunkKey): Promise<Chunk | null> {
    return await Promise.resolve(this.#chat(chatId).get(keyOf(key)) ?? null);
  }

  async save(chatId: ChatId, chunk: Chunk): Promise<void> {
    this.#chat(chatId).set(keyOf(chunk), { ...chunk, chatId });
    await Promise.resolve();
  }

  async deleteCovering(chatId: ChatId, messageIds: readonly MessageId[]): Promise<number> {
    const chat = this.#chat(chatId);
    let deleted = 0;
    for (const [key, chunk] of chat) {
      if (messageIds.some((messageId) => chunkCovers(chunk, messageId))) {
        chat.delete(key);
        deleted += 1;
      }
    }
    return await Promise.resolve(deleted);
  }

  async deleteExpired(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const chat = this.#chat(chatId);
    let deleted = 0;
    for (const [key, chunk] of chat) {
      const newest = this.#newestCovered(chatId, chunk);
      const reference = newest ?? chunk.createdAt;
      if (Temporal.Instant.compare(reference, cutoff) < 0) {
        chat.delete(key);
        deleted += 1;
      }
    }
    return await Promise.resolve(deleted);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const deleted = this.#chat(chatId).size;
    this.#rows.delete(chatId);
    return await Promise.resolve(deleted);
  }

  /* ---------------------------- test helpers ----------------------------- */

  knownChatIds(): readonly ChatId[] {
    return [...this.#rows.keys()];
  }

  dump(chatId: ChatId): readonly Chunk[] {
    return [...this.#chat(chatId).values()];
  }

  /* ------------------------------ internals ------------------------------ */

  #chat(chatId: ChatId): Map<string, Chunk> {
    let chat = this.#rows.get(chatId);
    if (chat === undefined) {
      chat = new Map<string, Chunk>();
      this.#rows.set(chatId, chat);
    }
    return chat;
  }

  /** Newest timestamp among the messages the chunk covers, or `null` if none survive. */
  #newestCovered(chatId: ChatId, chunk: Chunk): Temporal.Instant | null {
    if (this.messages === undefined) return null;
    let newest: Temporal.Instant | null = null;
    for (const row of this.messages.dump(chatId)) {
      if (!chunkCovers(chunk, row.messageId)) continue;
      if (newest === null || Temporal.Instant.compare(row.ts, newest) > 0) newest = row.ts;
    }
    return newest;
  }
}
