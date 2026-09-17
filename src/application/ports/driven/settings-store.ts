/**
 * `SettingsStore` — `chat_settings` and `user_prefs` (DESIGN §4, §10).
 *
 * This store is also configuration layer 4: `getChatSettings` feeds
 * `chatLayerFromSettings`, which feeds `__derive`. A write here must invalidate
 * the per-chat derived config cache (DESIGN §10) — that wiring is the config
 * adapter's job, but the ordering is why `put*` returns the new row.
 *
 * `chatId` is the required first parameter of every method (DESIGN §6.1).
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type {
  ChatSettings,
  ChatSettingsPatch,
  UserPrefs,
  UserPrefsPatch,
} from '../../../domain/model/settings.js';

export interface SettingsStore {
  /** `null` when the chat has never set anything: inherit every layer below. */
  getChatSettings(chatId: ChatId): Promise<ChatSettings | null>;

  /** Applies a partial write and returns the resulting row. */
  putChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    updatedBy: UserId,
    at: Temporal.Instant,
  ): Promise<ChatSettings>;

  getUserPrefs(chatId: ChatId, userId: UserId): Promise<UserPrefs | null>;

  putUserPrefs(chatId: ChatId, userId: UserId, patch: UserPrefsPatch): Promise<UserPrefs>;

  /** `/forgetme` (DESIGN §5): the user's preferences are their data too. */
  deleteUser(chatId: ChatId, userId: UserId): Promise<void>;

  /** `/forget`: chat settings and every user preference row for the chat. */
  deleteChat(chatId: ChatId): Promise<void>;
}
