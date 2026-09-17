/**
 * `PollStateStore` — `poll_state` (DESIGN §3, §4).
 *
 * Not chat-scoped, and therefore the one store port with no `chatId`
 * parameter: Telegram permits exactly one poller, so this is a single row.
 * Persisting the offset is crash recovery for free, and `lastSeenAt` is what
 * startup gap detection compares against (DESIGN §4).
 */
import type { PollState } from '../../../domain/model/settings.js';

export interface PollStateStore {
  /** `null` on a fresh database: start from Telegram's own backlog. */
  load(): Promise<PollState | null>;

  /** Written after each batch of updates is durably stored, never before. */
  save(state: PollState): Promise<void>;

  clear(): Promise<void>;
}
