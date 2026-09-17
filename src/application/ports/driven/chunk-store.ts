/**
 * `ChunkStore` — the compacted-summary cache (DESIGN §4, §5, §7).
 *
 * Two rules the implementation must not soften:
 *
 * - The cache key includes `model` and `promptVersion` (part of `ChunkKey`), or
 *   you serve summaries from a prompt you have since fixed.
 * - A chunk's TTL is the TTL of its **newest covered message**. A cached summary
 *   must never outlive the messages it summarizes.
 *
 * `chatId` is the required first parameter of every method (DESIGN §6.1).
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, MessageId } from '../../../domain/model/ids.js';
import type { Chunk, ChunkKey } from '../../../domain/model/chunk.js';

export interface ChunkStore {
  /** Exact-key lookup. A `promptVersion` bump must miss. */
  find(chatId: ChatId, key: ChunkKey): Promise<Chunk | null>;

  save(chatId: ChatId, chunk: Chunk): Promise<void>;

  /**
   * `/forgetme` cascade (DESIGN §5): delete every chunk whose
   * `[firstMsgId, lastMsgId]` range **overlaps** any of these ids. Coarse,
   * cheap, correct. Returns the number of chunks deleted.
   */
  deleteCovering(chatId: ChatId, messageIds: readonly MessageId[]): Promise<number>;

  /**
   * TTL sweep: delete every chunk whose newest covered message is older than
   * `cutoff` — or is gone entirely. Returns the number of chunks deleted.
   */
  deleteExpired(chatId: ChatId, cutoff: Temporal.Instant): Promise<number>;

  /** `/forget`: wipe the chat's chunks. Returns the number deleted. */
  deleteChat(chatId: ChatId): Promise<number>;
}
