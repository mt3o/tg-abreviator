/**
 * `better-sqlite3` `SettingsStore` — `chat_settings` and `user_prefs`
 * (DESIGN §4, §10).
 *
 * Patch semantics (an absent key leaves the column alone, `null` clears it)
 * are resolved in JS against the current row before writing the full row
 * back — the same approach `test/fakes/fake-settings-store.ts` takes, so the
 * two never disagree about what "absent" means for a nullable column.
 */
import type Database from 'better-sqlite3';

import { asChatId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type {
  ChatSettings,
  ChatSettingsPatch,
  UserPrefs,
  UserPrefsPatch,
} from '../../../domain/model/settings.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import type { SettingsStore } from '../../../application/ports/driven/settings-store.js';
import { fromEpochMillis, fromSqliteBool, toEpochMillis, toSqliteBool } from './codec.js';

interface ChatSettingsRow {
  readonly chat_id: number;
  readonly tz: string | null;
  readonly model_alias: string | null;
  readonly updated_by: number | null;
  readonly updated_at: number | null;
}

interface UserPrefsRow {
  readonly chat_id: number;
  readonly user_id: number;
  readonly dm_delivery: number;
}

function toChatSettings(row: ChatSettingsRow): ChatSettings {
  return {
    chatId: asChatId(row.chat_id),
    tz: row.tz,
    modelAlias: row.model_alias,
    updatedBy: row.updated_by === null ? null : asUserId(row.updated_by),
    updatedAt: row.updated_at === null ? null : fromEpochMillis(row.updated_at),
  };
}

function toUserPrefs(row: UserPrefsRow): UserPrefs {
  return {
    chatId: asChatId(row.chat_id),
    userId: asUserId(row.user_id),
    dmDelivery: fromSqliteBool(row.dm_delivery),
  };
}

export class SqliteSettingsStore implements SettingsStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  async getChatSettings(chatId: ChatId): Promise<ChatSettings | null> {
    const row = this.#db
      .prepare('SELECT * FROM chat_settings WHERE chat_id = @chatId')
      .get({ chatId }) as ChatSettingsRow | undefined;
    return await Promise.resolve(row === undefined ? null : toChatSettings(row));
  }

  async putChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    updatedBy: UserId,
    at: Temporal.Instant,
  ): Promise<ChatSettings> {
    const write = this.#db.transaction((): ChatSettings => {
      const current = this.#db
        .prepare('SELECT * FROM chat_settings WHERE chat_id = @chatId')
        .get({ chatId }) as ChatSettingsRow | undefined;

      const tz = patch.tz === undefined ? (current?.tz ?? null) : patch.tz;
      const modelAlias =
        patch.modelAlias === undefined ? (current?.model_alias ?? null) : patch.modelAlias;

      this.#db
        .prepare(
          `INSERT INTO chat_settings (chat_id, tz, model_alias, updated_by, updated_at)
           VALUES (@chatId, @tz, @modelAlias, @updatedBy, @updatedAt)
           ON CONFLICT (chat_id) DO UPDATE SET
             tz = excluded.tz,
             model_alias = excluded.model_alias,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .run({ chatId, tz, modelAlias, updatedBy, updatedAt: toEpochMillis(at) });

      return {
        chatId,
        tz,
        modelAlias,
        updatedBy,
        updatedAt: at,
      };
    });
    return await Promise.resolve(write());
  }

  async getUserPrefs(chatId: ChatId, userId: UserId): Promise<UserPrefs | null> {
    const row = this.#db
      .prepare('SELECT * FROM user_prefs WHERE chat_id = @chatId AND user_id = @userId')
      .get({ chatId, userId }) as UserPrefsRow | undefined;
    return await Promise.resolve(row === undefined ? null : toUserPrefs(row));
  }

  async putUserPrefs(chatId: ChatId, userId: UserId, patch: UserPrefsPatch): Promise<UserPrefs> {
    const write = this.#db.transaction((): UserPrefs => {
      const current = this.#db
        .prepare('SELECT * FROM user_prefs WHERE chat_id = @chatId AND user_id = @userId')
        .get({ chatId, userId }) as UserPrefsRow | undefined;

      const dmDelivery = patch.dmDelivery ?? (current === undefined ? false : fromSqliteBool(current.dm_delivery));

      this.#db
        .prepare(
          `INSERT INTO user_prefs (chat_id, user_id, dm_delivery)
           VALUES (@chatId, @userId, @dmDelivery)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET dm_delivery = excluded.dm_delivery`,
        )
        .run({ chatId, userId, dmDelivery: toSqliteBool(dmDelivery) });

      return { chatId, userId, dmDelivery };
    });
    return await Promise.resolve(write());
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    this.#db
      .prepare('DELETE FROM user_prefs WHERE chat_id = @chatId AND user_id = @userId')
      .run({ chatId, userId });
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    const wipe = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM chat_settings WHERE chat_id = @chatId').run({ chatId });
      this.#db.prepare('DELETE FROM user_prefs WHERE chat_id = @chatId').run({ chatId });
    });
    wipe();
    await Promise.resolve();
  }
}
