/**
 * Forward-only migration runner (PLAN, WS1).
 *
 * Applies every migration newer than what `_migrations` records, in strictly
 * increasing `id` order, each inside its own transaction. There is no down
 * migration and no re-ordering: once a migration id has shipped, it is
 * permanent.
 */
import type Database from 'better-sqlite3';

import { migration0001Init } from './0001_init.js';
import type { Migration } from './types.js';

export const MIGRATIONS: readonly Migration[] = Object.freeze([migration0001Init]);

interface MigrationRow {
  readonly id: number;
}

/** Idempotent: safe to call on every boot. */
export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id         INTEGER NOT NULL PRIMARY KEY,
       name       TEXT    NOT NULL,
       applied_at INTEGER NOT NULL
     ) STRICT;`,
  );

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as MigrationRow[]).map((row) => row.id),
  );

  const pending = [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => !applied.has(m.id));

  const recordApplied = db.prepare(
    'INSERT INTO _migrations (id, name, applied_at) VALUES (@id, @name, @appliedAt)',
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run({ id: migration.id, name: migration.name, appliedAt: Date.now() });
    });
    apply();
  }
}
