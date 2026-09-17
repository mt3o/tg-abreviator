-- tg-abreviator — canonical SQLite schema (DESIGN §4).
--
-- Frozen in Phase 0. WS1 owns the adapter and the forward-only numbered
-- migrations in ./migrations/; this file is the shape those migrations must
-- arrive at, and it is what the port-conformance suite is written against.
--
-- Conventions, once, so no adapter has to guess:
--
--   * Timestamps are INTEGER **epoch milliseconds, UTC** (`Temporal.Instant`'s
--     `epochMilliseconds`). Never a string, never seconds.
--   * `thread_id` NULL means General / a non-forum chat, matching
--     `StoredMessage.threadId === null`.
--   * `messages.message_id` is positive for real Telegram messages and
--     **negative for synthetic rows** — currently only gap markers (DESIGN §4),
--     which are real rows with no Telegram message behind them. Telegram never
--     issues a non-positive id, so the two spaces cannot collide.
--   * Every table is STRICT: a typed column that silently accepts a string is
--     exactly the sort of quiet corruption this bot cannot detect later.
--
-- Connection pragmas (DESIGN §3) belong to the adapter, not to this file, since
-- they are per-connection:
--
--   PRAGMA journal_mode = WAL;      -- never on NFS: WAL over NFS corrupts
--   PRAGMA busy_timeout = 5000;
--   PRAGMA synchronous = NORMAL;
--   PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- messages — the corpus. The only irreplaceable table: an unlogged message is
-- gone forever, because the Bot API cannot read history (DESIGN §1).
-- ---------------------------------------------------------------------------
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
  -- Upsert target: a replayed update and an `edited_message` are both idempotent
  -- here, and an edit updates in place — otherwise you summarize retracted
  -- claims (DESIGN §4).
  PRIMARY KEY (chat_id, message_id),
  CHECK (kind IN (
    'text', 'photo', 'video', 'animation', 'audio', 'voice', 'video_note',
    'document', 'sticker', 'poll', 'location', 'contact', 'dice', 'game',
    'service', 'gap_marker', 'redacted'
  ))
) STRICT;

-- Thread-scoped ranges (DESIGN §2).
CREATE INDEX IF NOT EXISTS messages_chat_thread_message
  ON messages (chat_id, thread_id, message_id);

-- Time-window ranges and the TTL sweeper (DESIGN §5).
CREATE INDEX IF NOT EXISTS messages_chat_ts
  ON messages (chat_id, ts);

-- The `/forgetme` cascade (DESIGN §5).
CREATE INDEX IF NOT EXISTS messages_chat_user
  ON messages (chat_id, user_id);

-- ---------------------------------------------------------------------------
-- chunks — compacted summaries (DESIGN §7).
-- TTL = TTL of the chunk's newest covered message (DESIGN §5): a cached summary
-- must never outlive the messages it summarizes.
-- ---------------------------------------------------------------------------
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

-- The cache key, including `model` and `prompt_version` — "or you serve
-- summaries from a prompt you have since fixed" (DESIGN §7). `ifnull` because a
-- NULL thread_id must collide with itself, which NULL does not do in SQL.
CREATE UNIQUE INDEX IF NOT EXISTS chunks_key
  ON chunks (chat_id, ifnull(thread_id, -1), first_msg_id, last_msg_id, model, prompt_version);

-- Overlap queries: the `/forgetme` cascade and the TTL sweep.
CREATE INDEX IF NOT EXISTS chunks_chat_span
  ON chunks (chat_id, first_msg_id, last_msg_id);

-- ---------------------------------------------------------------------------
-- chat_settings — also configuration layer 4 (DESIGN §10).
-- NULL means "inherit the layer below", not "off".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id     INTEGER NOT NULL PRIMARY KEY,
  tz          TEXT,
  model_alias TEXT,
  updated_by  INTEGER,
  updated_at  INTEGER
) STRICT;

-- ---------------------------------------------------------------------------
-- user_prefs — per-user delivery preference (DESIGN §8).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_prefs (
  chat_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  dm_delivery INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id),
  CHECK (dm_delivery IN (0, 1))
) STRICT;

-- ---------------------------------------------------------------------------
-- opt_outs — DESIGN §5. An opted-out user is stored as nothing at all; this row
-- is the record of the refusal, not a placeholder for their messages.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opt_outs (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- poll_state — the long-polling cursor (DESIGN §3, §4). Exactly one row:
-- Telegram permits exactly one poller, and two would mean 409 Conflict.
-- `last_seen_at` is what startup gap detection compares against.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- pseudonyms — readable labels for external surfaces (DESIGN §11).
-- Deleting the row makes the external label permanently unresolvable, which is
-- the entire reason this is a mapping table and not an HMAC.
-- The chat's own label lives in the row with user_id = 0; Telegram never issues
-- user id 0.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pseudonyms (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) STRICT;

-- A label must identify one subject within its chat, or the error sink lies.
CREATE UNIQUE INDEX IF NOT EXISTS pseudonyms_chat_label
  ON pseudonyms (chat_id, label);

-- Expired by the TTL sweeper on the same schedule as messages (DESIGN §11).
CREATE INDEX IF NOT EXISTS pseudonyms_chat_created
  ON pseudonyms (chat_id, created_at);

-- ---------------------------------------------------------------------------
-- usage_events — a per-call event log, and therefore a richer personal-data
-- artifact than a daily rollup (DESIGN §4). So: the question **hash** only,
-- never the text; the same TTL as messages; long-lived stats come from
-- aggregate rollups carrying no user_id.
--
-- `user_id` is TEXT, not INTEGER, on purpose: `/forgetme` replaces it with a
-- freshly generated random token stored nowhere else (DESIGN §5). Not a hash —
-- Telegram user ids are a small enumerable integer space, so a deterministic
-- hash is re-linkable and therefore not erasure.
--
-- `unit_prices_json` is stored per row so that editing the config price table
-- does not silently rewrite last month's history.
-- ---------------------------------------------------------------------------
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

-- Per-chat daily caps and in-chat stats (DESIGN §9).
CREATE INDEX IF NOT EXISTS usage_events_chat_ts
  ON usage_events (chat_id, ts);

-- The global daily USD budget — the hard stop — and the TTL sweep (DESIGN §9).
CREATE INDEX IF NOT EXISTS usage_events_ts
  ON usage_events (ts);

-- The `/forgetme` anonymisation pass.
CREATE INDEX IF NOT EXISTS usage_events_chat_user
  ON usage_events (chat_id, user_id);
