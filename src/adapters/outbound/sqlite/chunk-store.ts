/**
 * `better-sqlite3` `ChunkStore` (DESIGN §4, §5, §7).
 *
 * The cache key matches `chunks_key` exactly (`ifnull(thread_id, -1)`), and
 * `deleteExpired` is a correlated subquery against `messages` for the
 * chunk's newest surviving covered message — the same rule
 * `test/fakes/fake-chunk-store.ts` implements by walking the fake message
 * store directly.
 */
import type Database from 'better-sqlite3';

import { asChatId, asMessageId, asOptionalThreadId } from '../../../domain/model/ids.js';
import type { ChatId, MessageId } from '../../../domain/model/ids.js';
import type { Chunk, ChunkKey } from '../../../domain/model/chunk.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChunkStore } from '../../../application/ports/driven/chunk-store.js';
import { fromEpochMillis, toEpochMillis } from './codec.js';

interface ChunkRow {
  readonly chat_id: number;
  readonly thread_id: number | null;
  readonly first_msg_id: number;
  readonly last_msg_id: number;
  readonly model: string;
  readonly prompt_version: string;
  readonly text: string;
  readonly created_at: number;
}

function toDomain(row: ChunkRow): Chunk {
  return {
    chatId: asChatId(row.chat_id),
    threadId: asOptionalThreadId(row.thread_id),
    firstMsgId: asMessageId(row.first_msg_id),
    lastMsgId: asMessageId(row.last_msg_id),
    model: row.model,
    promptVersion: row.prompt_version,
    text: row.text,
    createdAt: fromEpochMillis(row.created_at),
  };
}

const FIND_SQL = `
  SELECT * FROM chunks
  WHERE chat_id = @chatId
    AND ifnull(thread_id, -1) = ifnull(@threadId, -1)
    AND first_msg_id = @firstMsgId
    AND last_msg_id = @lastMsgId
    AND model = @model
    AND prompt_version = @promptVersion
`;

const SAVE_SQL = `
  INSERT INTO chunks (chat_id, thread_id, first_msg_id, last_msg_id, model, prompt_version, text, created_at)
  VALUES (@chatId, @threadId, @firstMsgId, @lastMsgId, @model, @promptVersion, @text, @createdAt)
  ON CONFLICT (chat_id, ifnull(thread_id, -1), first_msg_id, last_msg_id, model, prompt_version)
  DO UPDATE SET text = excluded.text, created_at = excluded.created_at
`;

export class SqliteChunkStore implements ChunkStore {
  readonly #db: Database.Database;
  readonly #findStatement: Database.Statement;
  readonly #saveStatement: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#findStatement = db.prepare(FIND_SQL);
    this.#saveStatement = db.prepare(SAVE_SQL);
  }

  async find(chatId: ChatId, key: ChunkKey): Promise<Chunk | null> {
    const row = this.#findStatement.get({
      chatId,
      threadId: key.threadId,
      firstMsgId: key.firstMsgId,
      lastMsgId: key.lastMsgId,
      model: key.model,
      promptVersion: key.promptVersion,
    }) as ChunkRow | undefined;
    return await Promise.resolve(row === undefined ? null : toDomain(row));
  }

  async save(chatId: ChatId, chunk: Chunk): Promise<void> {
    this.#saveStatement.run({
      chatId,
      threadId: chunk.threadId,
      firstMsgId: chunk.firstMsgId,
      lastMsgId: chunk.lastMsgId,
      model: chunk.model,
      promptVersion: chunk.promptVersion,
      text: chunk.text,
      createdAt: toEpochMillis(chunk.createdAt),
    });
    await Promise.resolve();
  }

  async deleteCovering(chatId: ChatId, messageIds: readonly MessageId[]): Promise<number> {
    if (messageIds.length === 0) return await Promise.resolve(0);
    const params: Record<string, unknown> = { chatId };
    const clauses = messageIds.map((id, index) => {
      params[`id${String(index)}`] = id;
      return `@id${String(index)} BETWEEN first_msg_id AND last_msg_id`;
    });
    const sql = `DELETE FROM chunks WHERE chat_id = @chatId AND (${clauses.join(' OR ')})`;
    const info = this.#db.prepare(sql).run(params);
    return await Promise.resolve(info.changes);
  }

  async deleteExpired(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const sql = `
      DELETE FROM chunks
      WHERE chat_id = @chatId
        AND (
          (SELECT MAX(ts) FROM messages m
             WHERE m.chat_id = chunks.chat_id
               AND m.message_id BETWEEN chunks.first_msg_id AND chunks.last_msg_id) IS NULL
          OR (SELECT MAX(ts) FROM messages m
                WHERE m.chat_id = chunks.chat_id
                  AND m.message_id BETWEEN chunks.first_msg_id AND chunks.last_msg_id) < @cutoff
        )
    `;
    const info = this.#db.prepare(sql).run({ chatId, cutoff: toEpochMillis(cutoff) });
    return await Promise.resolve(info.changes);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const info = this.#db.prepare('DELETE FROM chunks WHERE chat_id = @chatId').run({ chatId });
    return await Promise.resolve(info.changes);
  }
}
