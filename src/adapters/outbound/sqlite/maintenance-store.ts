/**
 * `better-sqlite3` `MaintenanceStore` — the chat enumerator the TTL sweeper
 * needs (DESIGN §5).
 *
 * Every deletion method on every other store is chat-scoped by construction
 * (DESIGN §6.1), so this is the one deliberate "every chat" query, answering
 * ids only, never rows.
 */
import type Database from 'better-sqlite3';

import { asChatId } from '../../../domain/model/ids.js';
import type { ChatId } from '../../../domain/model/ids.js';
import type { MaintenanceStore } from '../../../application/ports/driven/maintenance-store.js';

const LIST_CHAT_IDS_SQL = `
  SELECT chat_id FROM messages
  UNION SELECT chat_id FROM chunks
  UNION SELECT chat_id FROM chat_settings
  UNION SELECT chat_id FROM user_prefs
  UNION SELECT chat_id FROM opt_outs
  UNION SELECT chat_id FROM usage_events
  UNION SELECT chat_id FROM pseudonyms
  ORDER BY chat_id ASC
`;

export class SqliteMaintenanceStore implements MaintenanceStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  async listChatIds(): Promise<readonly ChatId[]> {
    const rows = this.#db.prepare(LIST_CHAT_IDS_SQL).all() as { chat_id: number }[];
    return await Promise.resolve(rows.map((row) => asChatId(row.chat_id)));
  }
}
