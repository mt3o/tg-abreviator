/**
 * `better-sqlite3` `PollStateStore` — `poll_state` (DESIGN §3, §4).
 *
 * The table's own `poll_state_is_a_singleton` trigger (schema.sql) forbids a
 * second row via `INSERT`, so `save()` clears the row and re-inserts inside
 * one transaction rather than trying to `UPDATE` a primary key that changes
 * on every call.
 */
import type Database from 'better-sqlite3';

import type { PollState } from '../../../domain/model/settings.js';
import type { PollStateStore } from '../../../application/ports/driven/poll-state-store.js';
import { fromEpochMillis, toEpochMillis } from './codec.js';

interface PollStateRow {
  readonly last_update_id: number;
  readonly last_seen_at: number;
}

export class SqlitePollStateStore implements PollStateStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  async load(): Promise<PollState | null> {
    const row = this.#db.prepare('SELECT * FROM poll_state LIMIT 1').get() as
      | PollStateRow
      | undefined;
    if (row === undefined) return await Promise.resolve(null);
    return await Promise.resolve({
      lastUpdateId: row.last_update_id,
      lastSeenAt: fromEpochMillis(row.last_seen_at),
    });
  }

  async save(state: PollState): Promise<void> {
    const write = this.#db.transaction(() => {
      this.#db.exec('DELETE FROM poll_state');
      this.#db
        .prepare('INSERT INTO poll_state (last_update_id, last_seen_at) VALUES (@lastUpdateId, @lastSeenAt)')
        .run({ lastUpdateId: state.lastUpdateId, lastSeenAt: toEpochMillis(state.lastSeenAt) });
    });
    write();
    await Promise.resolve();
  }

  async clear(): Promise<void> {
    this.#db.exec('DELETE FROM poll_state');
    await Promise.resolve();
  }
}
