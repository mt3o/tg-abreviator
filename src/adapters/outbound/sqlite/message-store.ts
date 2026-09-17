/**
 * `better-sqlite3` `MessageStore` (DESIGN §3, §4).
 *
 * Every method mirrors `test/fakes/fake-message-store.ts` field for field —
 * the two are checked by the same port-conformance suite, so a divergence is
 * a bug here, not a documentation gap.
 */
import type Database from 'better-sqlite3';

import { AnchorNotFoundError, InvalidValueError } from '../../../domain/errors.js';
import {
  asChatId,
  asMessageId,
  asOptionalThreadId,
  asUserId,
} from '../../../domain/model/ids.js';
import type { ChatId, MessageId, UserId } from '../../../domain/model/ids.js';
import { isMessageKind } from '../../../domain/model/message.js';
import type { MessageKind, StoredMessage } from '../../../domain/model/message.js';
import type { ResolvedRange } from '../../../domain/model/range.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import type { Scope } from '../../../domain/model/scope.js';
import type {
  GapMarkerInput,
  MessageQueryOptions,
  MessageStore,
} from '../../../application/ports/driven/message-store.js';
import { fromEpochMillis, toEpochMillis } from './codec.js';

interface MessageRow {
  readonly chat_id: number;
  readonly message_id: number;
  readonly thread_id: number | null;
  readonly user_id: number | null;
  readonly display_name: string | null;
  readonly ts: number;
  readonly reply_to_message_id: number | null;
  readonly kind: string;
  readonly text: string | null;
}

function toKind(value: string): MessageKind {
  if (!isMessageKind(value)) {
    throw new InvalidValueError(`unknown message kind stored in SQLite: ${value}`);
  }
  return value;
}

function toDomain(row: MessageRow): StoredMessage {
  return {
    chatId: asChatId(row.chat_id),
    messageId: asMessageId(row.message_id),
    threadId: asOptionalThreadId(row.thread_id),
    userId: row.user_id === null ? null : asUserId(row.user_id),
    displayName: row.display_name,
    ts: fromEpochMillis(row.ts),
    replyToMessageId: row.reply_to_message_id === null ? null : asMessageId(row.reply_to_message_id),
    kind: toKind(row.kind),
    text: row.text,
  };
}

interface MessageRowParams {
  readonly chatId: number;
  readonly messageId: number;
  readonly threadId: number | null;
  readonly userId: number | null;
  readonly displayName: string | null;
  readonly ts: number;
  readonly replyToMessageId: number | null;
  readonly kind: string;
  readonly text: string | null;
}

function toParams(message: StoredMessage): MessageRowParams {
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    threadId: message.threadId,
    userId: message.userId,
    displayName: message.displayName,
    ts: toEpochMillis(message.ts),
    replyToMessageId: message.replyToMessageId,
    kind: message.kind,
    text: message.text,
  };
}

const UPSERT_SQL = `
  INSERT INTO messages
    (chat_id, message_id, thread_id, user_id, display_name, ts, reply_to_message_id, kind, text)
  VALUES
    (@chatId, @messageId, @threadId, @userId, @displayName, @ts, @replyToMessageId, @kind, @text)
  ON CONFLICT (chat_id, message_id) DO UPDATE SET
    thread_id            = excluded.thread_id,
    user_id              = excluded.user_id,
    display_name         = excluded.display_name,
    ts                    = excluded.ts,
    reply_to_message_id  = excluded.reply_to_message_id,
    kind                  = excluded.kind,
    text                  = excluded.text
`;

export class SqliteMessageStore implements MessageStore {
  readonly #db: Database.Database;
  readonly #upsertStatement: Database.Statement;
  readonly #findStatement: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#upsertStatement = db.prepare(UPSERT_SQL);
    this.#findStatement = db.prepare(
      'SELECT * FROM messages WHERE chat_id = @chatId AND message_id = @messageId',
    );
  }

  /* ------------------------------- writes -------------------------------- */

  async upsert(chatId: ChatId, message: StoredMessage): Promise<void> {
    this.#assertSameChat(chatId, message);
    this.#upsertStatement.run(toParams(message));
    await Promise.resolve();
  }

  async upsertMany(chatId: ChatId, messages: readonly StoredMessage[]): Promise<void> {
    for (const message of messages) this.#assertSameChat(chatId, message);
    const insertAll = this.#db.transaction((rows: readonly StoredMessage[]) => {
      for (const row of rows) this.#upsertStatement.run(toParams(row));
    });
    insertAll(messages);
    await Promise.resolve();
  }

  async insertGapMarker(chatId: ChatId, marker: GapMarkerInput): Promise<StoredMessage> {
    const insert = this.#db.transaction((): StoredMessage => {
      const min = this.#db
        .prepare('SELECT MIN(message_id) AS m FROM messages WHERE chat_id = @chatId AND message_id < 0')
        .get({ chatId }) as { m: number | null };
      const nextId = (min.m ?? 0) - 1;
      const row: StoredMessage = {
        chatId,
        messageId: asMessageId(nextId),
        threadId: marker.threadId,
        userId: null,
        displayName: null,
        ts: marker.ts,
        replyToMessageId: null,
        kind: 'gap_marker',
        text: marker.text,
      };
      this.#upsertStatement.run(toParams(row));
      return row;
    });
    return await Promise.resolve(insert());
  }

  /* ------------------------------- reads --------------------------------- */

  async findById(chatId: ChatId, messageId: MessageId): Promise<StoredMessage | null> {
    const row = this.#findStatement.get({ chatId, messageId }) as MessageRow | undefined;
    return await Promise.resolve(row === undefined ? null : toDomain(row));
  }

  async fetchRange(
    chatId: ChatId,
    range: ResolvedRange,
    options: MessageQueryOptions = {},
  ): Promise<readonly StoredMessage[]> {
    const matched = this.#matching(chatId, range, options);
    const result = matched.length > range.limit ? matched.slice(matched.length - range.limit) : matched;
    return await Promise.resolve(result);
  }

  async countInRange(
    chatId: ChatId,
    range: ResolvedRange,
    options: MessageQueryOptions = {},
  ): Promise<number> {
    // `range.limit` is deliberately not applied: the guards need the true size.
    return await Promise.resolve(this.#matching(chatId, range, options).length);
  }

  async newest(chatId: ChatId, scope: Scope): Promise<StoredMessage | null> {
    return await Promise.resolve(this.#edge(chatId, scope, 'DESC'));
  }

  async oldest(chatId: ChatId, scope: Scope): Promise<StoredMessage | null> {
    return await Promise.resolve(this.#edge(chatId, scope, 'ASC'));
  }

  async countAll(chatId: ChatId, scope: Scope): Promise<number> {
    const { clause, params } = this.#scopeClause(scope);
    const sql = `SELECT COUNT(*) AS n FROM messages WHERE chat_id = @chatId ${clause}`;
    const row = this.#db.prepare(sql).get({ chatId, ...params }) as { n: number };
    return await Promise.resolve(row.n);
  }

  /* ------------------------------ deletions ------------------------------ */

  async deleteByUser(chatId: ChatId, userId: UserId): Promise<readonly MessageId[]> {
    const rows = this.#db
      .prepare('DELETE FROM messages WHERE chat_id = @chatId AND user_id = @userId RETURNING message_id')
      .all({ chatId, userId }) as { message_id: number }[];
    const ids = rows.map((row) => asMessageId(row.message_id)).sort((a, b) => a - b);
    return await Promise.resolve(ids);
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const info = this.#db
      .prepare('DELETE FROM messages WHERE chat_id = @chatId AND ts < @cutoff')
      .run({ chatId, cutoff: toEpochMillis(cutoff) });
    return await Promise.resolve(info.changes);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const info = this.#db.prepare('DELETE FROM messages WHERE chat_id = @chatId').run({ chatId });
    return await Promise.resolve(info.changes);
  }

  /* ------------------------------ internals ------------------------------ */

  #assertSameChat(chatId: ChatId, message: StoredMessage): void {
    if (message.chatId !== chatId) {
      throw new InvalidValueError(
        `message belongs to chat ${String(message.chatId)}, not ${String(chatId)}`,
      );
    }
  }

  #scopeClause(scope: Scope): { clause: string; params: Record<string, unknown> } {
    if (scope.kind === 'all') return { clause: '', params: {} };
    if (scope.threadId === null) return { clause: 'AND thread_id IS NULL', params: {} };
    return { clause: 'AND thread_id = @threadId', params: { threadId: scope.threadId } };
  }

  #edge(chatId: ChatId, scope: Scope, direction: 'ASC' | 'DESC'): StoredMessage | null {
    const { clause, params } = this.#scopeClause(scope);
    const sql = `
      SELECT * FROM messages
      WHERE chat_id = @chatId ${clause}
      ORDER BY ts ${direction}, message_id ${direction}
      LIMIT 1
    `;
    const row = this.#db.prepare(sql).get({ chatId, ...params }) as MessageRow | undefined;
    return row === undefined ? null : toDomain(row);
  }

  #matching(
    chatId: ChatId,
    range: ResolvedRange,
    options: MessageQueryOptions,
  ): StoredMessage[] {
    const excludeUserIds = options.excludeUserIds ?? [];
    const excludeKinds = options.excludeKinds ?? [];

    const conditions: string[] = ['chat_id = @chatId', 'ts <= @end'];
    const params: Record<string, unknown> = { chatId, end: toEpochMillis(range.end) };

    if (range.scope.kind === 'thread') {
      if (range.scope.threadId === null) {
        conditions.push('thread_id IS NULL');
      } else {
        conditions.push('thread_id = @threadId');
        params.threadId = range.scope.threadId;
      }
    }

    if (excludeUserIds.length > 0) {
      const names = excludeUserIds.map((_id, index) => `@excludeUser${String(index)}`);
      excludeUserIds.forEach((id, index) => {
        params[`excludeUser${String(index)}`] = id;
      });
      conditions.push(`(user_id IS NULL OR user_id NOT IN (${names.join(', ')}))`);
    }

    if (excludeKinds.length > 0) {
      const names = excludeKinds.map((_kind, index) => `@excludeKind${String(index)}`);
      excludeKinds.forEach((kind, index) => {
        params[`excludeKind${String(index)}`] = kind;
      });
      conditions.push(`kind NOT IN (${names.join(', ')})`);
    }

    const start = range.start;

    if (start.kind === 'instant') {
      conditions.push('ts >= @startTs');
      params.startTs = toEpochMillis(start.ts);
      const sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY ts ASC, message_id ASC`;
      return (this.#db.prepare(sql).all(params) as MessageRow[]).map(toDomain);
    }

    if (start.kind === 'message') {
      const anchor = this.#findStatement.get({ chatId, messageId: start.messageId }) as
        | MessageRow
        | undefined;
      if (anchor === undefined) throw new AnchorNotFoundError();
      params.anchorTs = anchor.ts;
      params.anchorId = anchor.message_id;
      const comparator = start.inclusive ? '>=' : '>';
      conditions.push(`(ts, message_id) ${comparator} (@anchorTs, @anchorId)`);
      const sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY ts ASC, message_id ASC`;
      return (this.#db.prepare(sql).all(params) as MessageRow[]).map(toDomain);
    }

    // 'lastN': take the newest `count` of what survived the filters above.
    params.count = start.count;
    const sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY ts DESC, message_id DESC LIMIT @count`;
    const rows = (this.#db.prepare(sql).all(params) as MessageRow[]).reverse();
    return rows.map(toDomain);
  }
}
