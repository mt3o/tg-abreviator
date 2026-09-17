/** In-memory `SettingsStore` — `chat_settings` and `user_prefs`. */
import type { Temporal } from '../../src/domain/time/temporal.js';
import type { ChatId, UserId } from '../../src/domain/model/ids.js';
import type {
  ChatSettings,
  ChatSettingsPatch,
  UserPrefs,
  UserPrefsPatch,
} from '../../src/domain/model/settings.js';
import type { SettingsStore } from '../../src/application/ports/driven/settings-store.js';

function prefsKey(chatId: ChatId, userId: UserId): string {
  return `${String(chatId)}:${String(userId)}`;
}

export class FakeSettingsStore implements SettingsStore {
  readonly #chats = new Map<ChatId, ChatSettings>();
  readonly #prefs = new Map<string, UserPrefs>();

  async getChatSettings(chatId: ChatId): Promise<ChatSettings | null> {
    return await Promise.resolve(this.#chats.get(chatId) ?? null);
  }

  async putChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    updatedBy: UserId,
    at: Temporal.Instant,
  ): Promise<ChatSettings> {
    const current: ChatSettings = this.#chats.get(chatId) ?? {
      chatId,
      tz: null,
      modelAlias: null,
      updatedBy: null,
      updatedAt: null,
    };
    const next: ChatSettings = {
      chatId,
      tz: patch.tz === undefined ? current.tz : patch.tz,
      modelAlias: patch.modelAlias === undefined ? current.modelAlias : patch.modelAlias,
      updatedBy,
      updatedAt: at,
    };
    this.#chats.set(chatId, next);
    return await Promise.resolve(next);
  }

  async getUserPrefs(chatId: ChatId, userId: UserId): Promise<UserPrefs | null> {
    return await Promise.resolve(this.#prefs.get(prefsKey(chatId, userId)) ?? null);
  }

  async putUserPrefs(chatId: ChatId, userId: UserId, patch: UserPrefsPatch): Promise<UserPrefs> {
    const current: UserPrefs = this.#prefs.get(prefsKey(chatId, userId)) ?? {
      chatId,
      userId,
      dmDelivery: false,
    };
    const next: UserPrefs = {
      chatId,
      userId,
      dmDelivery: patch.dmDelivery === undefined ? current.dmDelivery : patch.dmDelivery,
    };
    this.#prefs.set(prefsKey(chatId, userId), next);
    return await Promise.resolve(next);
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    this.#prefs.delete(prefsKey(chatId, userId));
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    this.#chats.delete(chatId);
    for (const [key, prefs] of this.#prefs) {
      if (prefs.chatId === chatId) this.#prefs.delete(key);
    }
    await Promise.resolve();
  }

  knownChatIds(): readonly ChatId[] {
    const ids = new Set<ChatId>(this.#chats.keys());
    for (const prefs of this.#prefs.values()) ids.add(prefs.chatId);
    return [...ids];
  }
}
