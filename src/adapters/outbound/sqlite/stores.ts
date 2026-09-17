/**
 * One call that hands the composition root every SQLite store it needs,
 * mirroring `test/fakes/create-fake-stores.ts` so the two are interchangeable
 * behind the same ports.
 */
import type Database from 'better-sqlite3';

import type { Clock } from '../../../application/ports/driven/clock.js';
import type { IdGenerator } from '../../../application/ports/driven/id-generator.js';
import type { GlobalUsageStore, UsageStore } from '../../../application/ports/driven/usage-store.js';
import { SqliteChunkStore } from './chunk-store.js';
import { SqliteMaintenanceStore } from './maintenance-store.js';
import { SqliteMessageStore } from './message-store.js';
import { SqliteOptOutStore } from './opt-out-store.js';
import { SqlitePollStateStore } from './poll-state-store.js';
import { SqlitePseudonymStore } from './pseudonym-store.js';
import { SqliteSettingsStore } from './settings-store.js';
import { SqliteUsageStore } from './usage-store.js';

export interface SqliteStores {
  readonly messages: SqliteMessageStore;
  readonly chunks: SqliteChunkStore;
  readonly settings: SqliteSettingsStore;
  readonly optOuts: SqliteOptOutStore;
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
  readonly pollState: SqlitePollStateStore;
  readonly pseudonyms: SqlitePseudonymStore;
  readonly maintenance: SqliteMaintenanceStore;
}

export interface CreateSqliteStoresOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Every driven store this workstream owns, wired to one shared connection. */
export function createSqliteStores(db: Database.Database, options: CreateSqliteStoresOptions): SqliteStores {
  const usage = new SqliteUsageStore(db);
  return {
    messages: new SqliteMessageStore(db),
    chunks: new SqliteChunkStore(db),
    settings: new SqliteSettingsStore(db),
    optOuts: new SqliteOptOutStore(db),
    usage,
    globalUsage: usage,
    pollState: new SqlitePollStateStore(db),
    pseudonyms: new SqlitePseudonymStore(db, options.ids, options.clock),
    maintenance: new SqliteMaintenanceStore(db),
  };
}
