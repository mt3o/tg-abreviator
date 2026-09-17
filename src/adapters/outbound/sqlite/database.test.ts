/**
 * Connection-level behaviour DESIGN §3 requires: the four pragmas, and a
 * schema that never drifts from `schema.sql` — the shape Phase 0 froze and
 * the port-conformance suite is written against.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from './database.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every `CREATE TABLE|INDEX|TRIGGER <name>` in `schema.sql`, order-independent. */
function schemaObjectNames(sql: string): string[] {
  const pattern = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF NOT EXISTS\s+)?(\w+)/gi;
  const names: string[] = [];
  for (const match of sql.matchAll(pattern)) {
    const name = match[2];
    if (name !== undefined) names.push(name);
  }
  return names.sort();
}

describe('SQLite connection (DESIGN §3)', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-abreviator-database-'));
    dbPath = join(dir, 'nested', 'test.db');
    db = openDatabase({ path: dbPath });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets journal_mode=WAL, busy_timeout, synchronous=NORMAL and foreign_keys=ON', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // ON
  });

  it('honours a custom busy_timeout', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'tg-abreviator-database-'));
    const other = openDatabase({ path: join(dir2, 'test.db'), busyTimeoutMs: 12_345 });
    try {
      expect(other.pragma('busy_timeout', { simple: true })).toBe(12_345);
    } finally {
      closeDatabase(other);
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('creates the parent directory for the database file', () => {
    // beforeEach already opened a database under `<dir>/nested/test.db`.
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(rows.length).toBeGreaterThan(0);
  });

  it('is idempotent: reopening the same file does not re-run migrations', () => {
    closeDatabase(db);
    // Reopening must not throw (CREATE TABLE IF NOT EXISTS / recorded migration).
    const reopened = openDatabase({ path: dbPath });
    const migrations = reopened.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as {
      n: number;
    };
    expect(migrations.n).toBe(1);
    closeDatabase(reopened);
    db = openDatabase({ path: dbPath }); // afterEach expects a live handle
  });

  it('produces exactly the tables, indexes and triggers declared in schema.sql', () => {
    const schemaSql = readFileSync(join(HERE, 'schema.sql'), 'utf8');
    const declared = schemaObjectNames(schemaSql).filter((name) => name !== 'sqlite_autoindex');

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name != '_migrations'",
      )
      .all() as { name: string }[];
    const actual = rows.map((row) => row.name).sort();

    expect(actual).toEqual(declared);
  });
});
