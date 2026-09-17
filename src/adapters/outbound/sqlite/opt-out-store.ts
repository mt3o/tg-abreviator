/** `better-sqlite3` `OptOutStore` — `opt_outs` (DESIGN §4, §5). */
import type Database from 'better-sqlite3';

import { asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { OptOutStore } from '../../../application/ports/driven/opt-out-store.js';

export class SqliteOptOutStore implements OptOutStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  async isOptedOut(chatId: ChatId, userId: UserId): Promise<boolean> {
    const row = this.#db
      .prepare('SELECT 1 AS present FROM opt_outs WHERE chat_id = @chatId AND user_id = @userId')
      .get({ chatId, userId }) as { present: number } | undefined;
    return await Promise.resolve(row !== undefined);
  }

  async listOptedOut(chatId: ChatId): Promise<readonly UserId[]> {
    const rows = this.#db
      .prepare('SELECT user_id FROM opt_outs WHERE chat_id = @chatId ORDER BY user_id ASC')
      .all({ chatId }) as { user_id: number }[];
    return await Promise.resolve(rows.map((row) => asUserId(row.user_id)));
  }

  async optOut(chatId: ChatId, userId: UserId): Promise<void> {
    this.#db
      .prepare('INSERT OR IGNORE INTO opt_outs (chat_id, user_id) VALUES (@chatId, @userId)')
      .run({ chatId, userId });
    await Promise.resolve();
  }

  async optIn(chatId: ChatId, userId: UserId): Promise<void> {
    this.#db
      .prepare('DELETE FROM opt_outs WHERE chat_id = @chatId AND user_id = @userId')
      .run({ chatId, userId });
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    this.#db.prepare('DELETE FROM opt_outs WHERE chat_id = @chatId').run({ chatId });
    await Promise.resolve();
  }
}
