/**
 * Migration 0001 — initial schema.
 *
 * This must reach exactly the shape declared in
 * `src/adapters/outbound/sqlite/schema.sql` (frozen in Phase 0, DESIGN §4).
 * `schema.sql` is not executed directly — `tsconfig.build.json` compiles only
 * `.ts`, so a `.sql` asset would not survive into `dist` without a build step
 * this workstream is not permitted to add — so its statements are reproduced
 * verbatim below. `sqlite-schema.test.ts` asserts the two never drift apart.
 *
 * Connection pragmas (`journal_mode`, `busy_timeout`, `synchronous`,
 * `foreign_keys`) are per-connection, not part of the schema, and are set by
 * `openDatabase()` instead.
 */
import type { Migration } from './types.js';

const SQL = `
CREATE TABLE IF NOT EXISTS messages (
  chat_id             INTEGER NOT NULL,
  message_id          INTEGER NOT NULL,
  thread_id           INTEGER,
  user_id             INTEGER,
  display_name        TEXT,
  ts                  INTEGER NOT NULL,
  reply_to_message_id INTEGER,
  kind                TEXT    NOT NULL,
  text                TEXT,
  PRIMARY KEY (chat_id, message_id),
  CHECK (kind IN (
    'text', 'photo', 'video', 'animation', 'audio', 'voice', 'video_note',
    'document', 'sticker', 'poll', 'location', 'contact', 'dice', 'game',
    'service', 'gap_marker', 'redacted'
  ))
) STRICT;

CREATE INDEX IF NOT EXISTS messages_chat_thread_message
  ON messages (chat_id, thread_id, message_id);

CREATE INDEX IF NOT EXISTS messages_chat_ts
  ON messages (chat_id, ts);

CREATE INDEX IF NOT EXISTS messages_chat_user
  ON messages (chat_id, user_id);

CREATE TABLE IF NOT EXISTS chunks (
  chat_id        INTEGER NOT NULL,
  thread_id      INTEGER,
  first_msg_id   INTEGER NOT NULL,
  last_msg_id    INTEGER NOT NULL,
  model          TEXT    NOT NULL,
  prompt_version TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  CHECK (last_msg_id >= first_msg_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS chunks_key
  ON chunks (chat_id, ifnull(thread_id, -1), first_msg_id, last_msg_id, model, prompt_version);

CREATE INDEX IF NOT EXISTS chunks_chat_span
  ON chunks (chat_id, first_msg_id, last_msg_id);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id     INTEGER NOT NULL PRIMARY KEY,
  tz          TEXT,
  model_alias TEXT,
  updated_by  INTEGER,
  updated_at  INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  dm_delivery INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id),
  CHECK (dm_delivery IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS opt_outs (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS poll_state (
  last_update_id INTEGER NOT NULL PRIMARY KEY,
  last_seen_at   INTEGER NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS poll_state_is_a_singleton
BEFORE INSERT ON poll_state
WHEN (SELECT COUNT(*) FROM poll_state) > 0
BEGIN
  SELECT RAISE(ABORT, 'poll_state holds exactly one row');
END;

CREATE TABLE IF NOT EXISTS pseudonyms (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS pseudonyms_chat_label
  ON pseudonyms (chat_id, label);

CREATE INDEX IF NOT EXISTS pseudonyms_chat_created
  ON pseudonyms (chat_id, created_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id               TEXT    NOT NULL PRIMARY KEY,
  ts               INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  thread_id        INTEGER,
  user_id          TEXT,
  model            TEXT    NOT NULL,
  phase            TEXT    NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micros      INTEGER NOT NULL DEFAULT 0,
  unit_prices_json TEXT    NOT NULL,
  range_spec       TEXT    NOT NULL DEFAULT '',
  question_hash    TEXT,
  status           TEXT    NOT NULL,
  CHECK (phase IN ('single', 'map', 'reduce', 'count_tokens', 'feedback')),
  CHECK (status IN ('ok', 'error', 'refused', 'over_budget', 'cached', 'thumbs_up', 'thumbs_down'))
) STRICT;

CREATE INDEX IF NOT EXISTS usage_events_chat_ts
  ON usage_events (chat_id, ts);

CREATE INDEX IF NOT EXISTS usage_events_ts
  ON usage_events (ts);

CREATE INDEX IF NOT EXISTS usage_events_chat_user
  ON usage_events (chat_id, user_id);
`;

export const migration0001Init: Migration = Object.freeze({
  id: 1,
  name: 'init',
  sql: SQL,
});
