/**
 * `OptOutStore` — `opt_outs` (DESIGN §4, §5).
 *
 * DESIGN §5: opted-out users are stored as **nothing at all** — not even a
 * placeholder, because a placeholder is still their data. So this store is
 * consulted at ingest (drop the message) *and* at query time (filter rows that
 * predate the opt-out).
 *
 * `chatId` is the required first parameter of every method (DESIGN §6.1).
 */
import type { ChatId, UserId } from '../../../domain/model/ids.js';

export interface OptOutStore {
  isOptedOut(chatId: ChatId, userId: UserId): Promise<boolean>;

  /** For the query-time filter: pass into `MessageQueryOptions.excludeUserIds`. */
  listOptedOut(chatId: ChatId): Promise<readonly UserId[]>;

  /** Idempotent. `/forgetme` opts the user out of all *future* logging. */
  optOut(chatId: ChatId, userId: UserId): Promise<void>;

  /** Idempotent. Undo, should the user ask for it. */
  optIn(chatId: ChatId, userId: UserId): Promise<void>;

  deleteChat(chatId: ChatId): Promise<void>;
}
