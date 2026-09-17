/**
 * The one genuine cycle in the object graph, broken in the only place allowed
 * to know about it.
 *
 * `Config` needs a `SettingsStore`: the `chat` layer (DESIGN §10, layer 4) is
 * a SQLite-backed configuration layer, so `forChat()` reads `chat_settings`.
 * But the SQLite connection needs `database.path` and `database.busyTimeoutMs`,
 * which are themselves config — and DESIGN §10 step 5 requires the whole
 * resolved configuration to be validated *before* the process touches the
 * database or Telegram (README, "Troubleshooting: config errors on startup").
 *
 * Both constraints hold at once only if the store handed to `createConfig` is a
 * promise of one. This is that promise: an empty shell during validation,
 * bound to the real store the moment the connection is open. Nothing reads it
 * in between — `createConfig` stores the reference and calls nothing on it
 * until the first `forChat()`, which cannot happen before the poller starts.
 *
 * It is a shim, not behaviour: every method forwards, and calling one before
 * `bind()` is a composition bug rather than a runtime condition to handle, so
 * it throws instead of inventing an answer.
 */
import type { SettingsStore } from '../application/ports/driven/settings-store.js';
import type { Temporal } from '../domain/time/temporal.js';
import type { ChatId, UserId } from '../domain/model/ids.js';
import type {
  ChatSettings,
  ChatSettingsPatch,
  UserPrefs,
  UserPrefsPatch,
} from '../domain/model/settings.js';
import { InvalidValueError } from '../domain/errors.js';

export class DeferredSettingsStore implements SettingsStore {
  #target: SettingsStore | null = null;

  /** Called once, as soon as the real store exists. */
  bind(target: SettingsStore): void {
    this.#target = target;
  }

  get #store(): SettingsStore {
    if (this.#target === null) {
      throw new InvalidValueError('settings store used before the database was opened');
    }
    return this.#target;
  }

  async getChatSettings(chatId: ChatId): Promise<ChatSettings | null> {
    return await this.#store.getChatSettings(chatId);
  }

  async putChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    updatedBy: UserId,
    at: Temporal.Instant,
  ): Promise<ChatSettings> {
    return await this.#store.putChatSettings(chatId, patch, updatedBy, at);
  }

  async getUserPrefs(chatId: ChatId, userId: UserId): Promise<UserPrefs | null> {
    return await this.#store.getUserPrefs(chatId, userId);
  }

  async putUserPrefs(chatId: ChatId, userId: UserId, patch: UserPrefsPatch): Promise<UserPrefs> {
    return await this.#store.putUserPrefs(chatId, userId, patch);
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    await this.#store.deleteUser(chatId, userId);
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    await this.#store.deleteChat(chatId);
  }
}
