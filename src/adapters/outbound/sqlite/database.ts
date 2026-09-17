/**
 * Opens the `better-sqlite3` connection with the pragmas DESIGN §3 requires,
 * and brings the schema up to date via the forward-only migrations.
 *
 * Pragmas are per-connection, so they live here rather than in
 * `schema.sql`: `journal_mode=WAL` (never on NFS — WAL over NFS corrupts),
 * `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from './migrations/index.js';

export interface SqliteDatabaseOptions {
  /** Filesystem path to the database file, or `:memory:` for tests. */
  readonly path: string;
  /** DESIGN §3 default: 5000ms. */
  readonly busyTimeoutMs?: number;
}

function ensureParentDirectory(path: string): void {
  if (path === ':memory:' || path.startsWith('file::memory:')) return;
  const dir = dirname(path);
  if (dir === '' || dir === '.') return;
  mkdirSync(dir, { recursive: true });
}

/**
 * Opens (creating if necessary) the database file, applies the DESIGN §3
 * pragmas, and runs every pending migration. Safe to call once per process:
 * the composition root owns the single connection for the process lifetime.
 */
export function openDatabase(options: SqliteDatabaseOptions): Database.Database {
  ensureParentDirectory(options.path);

  const db = new Database(options.path);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 5000)}`);
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
