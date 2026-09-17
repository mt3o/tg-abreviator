/**
 * `better-sqlite3` `PseudonymStore` — `pseudonyms` (DESIGN §11).
 *
 * Allocation draws from the shared word list via the `IdGenerator` port
 * (never `Math.random`), and retries on the rare label collision — the
 * `pseudonyms_chat_label` unique index is the backstop that makes a
 * collision detectable at all. Deleting a row is the entire mechanism
 * DESIGN §11 depends on: once gone, the label already sitting in the error
 * sink resolves to nothing, forever.
 */
import type Database from 'better-sqlite3';

import {
  CHAT_PSEUDONYM_USER_ID,
  PSEUDONYM_ADJECTIVES,
  PSEUDONYM_NOUNS,
  composeLabel,
} from '../../../domain/model/pseudonym.js';
import type { PseudonymLabel } from '../../../domain/model/pseudonym.js';
import { asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import type { PseudonymStore } from '../../../application/ports/driven/pseudonym-store.js';
import type { IdGenerator } from '../../../application/ports/driven/id-generator.js';
import type { Clock } from '../../../application/ports/driven/clock.js';
import { toEpochMillis } from './codec.js';

const MAX_ALLOCATION_ATTEMPTS = 100;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class SqlitePseudonymStore implements PseudonymStore {
  readonly #db: Database.Database;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;

  constructor(db: Database.Database, ids: IdGenerator, clock: Clock) {
    this.#db = db;
    this.#ids = ids;
    this.#clock = clock;
  }

  async labelFor(chatId: ChatId, userId: UserId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, userId));
  }

  async labelForChat(chatId: ChatId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, CHAT_PSEUDONYM_USER_ID));
  }

  async peek(chatId: ChatId, userId: UserId): Promise<PseudonymLabel | null> {
    const row = this.#db
      .prepare('SELECT label FROM pseudonyms WHERE chat_id = @chatId AND user_id = @userId')
      .get({ chatId, userId }) as { label: string } | undefined;
    return await Promise.resolve(row === undefined ? null : (row.label as PseudonymLabel));
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    this.#db
      .prepare('DELETE FROM pseudonyms WHERE chat_id = @chatId AND user_id = @userId')
      .run({ chatId, userId });
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    this.#db.prepare('DELETE FROM pseudonyms WHERE chat_id = @chatId').run({ chatId });
    await Promise.resolve();
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const info = this.#db
      .prepare('DELETE FROM pseudonyms WHERE chat_id = @chatId AND created_at < @cutoff')
      .run({ chatId, cutoff: toEpochMillis(cutoff) });
    return await Promise.resolve(info.changes);
  }

  /* ------------------------------ internals ------------------------------ */

  #allocate(chatId: ChatId, subjectUserId: number): PseudonymLabel {
    const existing = this.#db
      .prepare('SELECT label FROM pseudonyms WHERE chat_id = @chatId AND user_id = @userId')
      .get({ chatId, userId: subjectUserId }) as { label: string } | undefined;
    if (existing !== undefined) return existing.label as PseudonymLabel;

    const insert = this.#db.prepare(
      'INSERT INTO pseudonyms (chat_id, user_id, label, created_at) VALUES (@chatId, @userId, @label, @createdAt)',
    );
    const createdAt = toEpochMillis(this.#clock.now());

    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const label = composeLabel(
        this.#ids.randomInt(PSEUDONYM_ADJECTIVES.length),
        this.#ids.randomInt(PSEUDONYM_NOUNS.length),
      );
      try {
        insert.run({ chatId, userId: subjectUserId, label, createdAt });
        return label;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // Either this (chat, user) row was raced into existence, or the label
        // collided with another subject's. Re-check the row before retrying —
        // the former means we are done, not that we need another attempt.
        const raced = this.#db
          .prepare('SELECT label FROM pseudonyms WHERE chat_id = @chatId AND user_id = @userId')
          .get({ chatId, userId: subjectUserId }) as { label: string } | undefined;
        if (raced !== undefined) return raced.label as PseudonymLabel;
      }
    }
    throw new Error(`could not allocate a pseudonym label for chat ${String(chatId)} after ${String(MAX_ALLOCATION_ATTEMPTS)} attempts`);
  }

  /* ---------------------------- test helper ------------------------------ */

  /** Reverse lookup for tests, as an operator would resolve a label locally. */
  resolve(chatId: ChatId, label: PseudonymLabel): UserId | null {
    const row = this.#db
      .prepare('SELECT user_id FROM pseudonyms WHERE chat_id = @chatId AND label = @label')
      .get({ chatId, label }) as { user_id: number } | undefined;
    if (row === undefined || row.user_id === CHAT_PSEUDONYM_USER_ID) return null;
    return asUserId(row.user_id);
  }
}
