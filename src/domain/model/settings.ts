/**
 * Per-chat and per-user state (DESIGN §4 `chat_settings`, `user_prefs`,
 * `poll_state`).
 *
 * `chat_settings` is also the fourth configuration layer (DESIGN §10): it is
 * read out of SQLite and handed to `__derive`, which is why the fields here are
 * nullable — an absent value means "inherit from the layer below", not "off".
 *
 * TTL is deliberately *not* here. It is operator-only and lives in the config
 * file: a group admin extending retention would be doing it to other people's
 * messages (DESIGN §2).
 */
import type { Temporal } from '../time/temporal.js';
import type { TimeZoneId } from '../time/temporal.js';
import type { ChatId, UserId } from './ids.js';

export interface ChatSettings {
  readonly chatId: ChatId;
  /** IANA zone, e.g. `Europe/Warsaw`. `null` inherits the configured default. */
  readonly tz: TimeZoneId | null;
  /** Model alias from the registry. `null` inherits the configured default. */
  readonly modelAlias: string | null;
  readonly updatedBy: UserId | null;
  readonly updatedAt: Temporal.Instant | null;
}

/** A partial write. An absent key leaves the column alone; `null` clears it. */
export interface ChatSettingsPatch {
  readonly tz?: TimeZoneId | null;
  readonly modelAlias?: string | null;
}

export interface UserPrefs {
  readonly chatId: ChatId;
  readonly userId: UserId;
  /** DESIGN §8: in-chat by default, `dm on` is an opt-in. */
  readonly dmDelivery: boolean;
}

export interface UserPrefsPatch {
  readonly dmDelivery?: boolean;
}

/**
 * Long-polling cursor (DESIGN §4 `poll_state`).
 *
 * Global, not chat-scoped: there is exactly one poller (Telegram permits one),
 * so this is the single row that survives a restart and gives crash recovery
 * for free. `lastSeenAt` is what startup gap detection compares against.
 */
export interface PollState {
  readonly lastUpdateId: number;
  readonly lastSeenAt: Temporal.Instant;
}
