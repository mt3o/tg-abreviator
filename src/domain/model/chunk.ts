/**
 * Compacted summaries (DESIGN §4 `chunks`, §7 "Compaction").
 *
 * A chunk is the map-phase output for one deterministic bucket of messages.
 * Its cache key includes `model` and `promptVersion` — "or you serve summaries
 * from a prompt you have since fixed" (DESIGN §7).
 *
 * Its TTL is the TTL of its newest covered message (DESIGN §5): a cached
 * summary must never outlive the messages it summarizes.
 */
import type { Temporal } from '../time/temporal.js';
import type { ChatId, MessageId, ThreadId } from './ids.js';

/**
 * Everything that identifies a chunk. Two calls a minute apart must produce the
 * same key for the same completed bucket, which is why bucket boundaries are
 * deterministic (DESIGN §7).
 */
export interface ChunkKey {
  readonly threadId: ThreadId | null;
  readonly firstMsgId: MessageId;
  readonly lastMsgId: MessageId;
  /** Concrete provider model id the chunk was produced with. */
  readonly model: string;
  /** Prompt revision the chunk was produced with. */
  readonly promptVersion: string;
}

export interface Chunk extends ChunkKey {
  readonly chatId: ChatId;
  readonly text: string;
  readonly createdAt: Temporal.Instant;
}

/** True when `[firstMsgId, lastMsgId]` covers `messageId`, inclusive. */
export function chunkCovers(key: ChunkKey, messageId: MessageId): boolean {
  return messageId >= key.firstMsgId && messageId <= key.lastMsgId;
}
