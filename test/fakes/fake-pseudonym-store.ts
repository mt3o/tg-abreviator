/**
 * In-memory `PseudonymStore` (DESIGN §11).
 *
 * Allocation goes through `IdGenerator`, so a seeded generator produces the same
 * labels every run — which is what makes "a deleted row renders an
 * already-emitted label unresolvable" a testable statement rather than a hope.
 */
import type { Temporal } from '../../src/domain/time/temporal.js';
import {
  CHAT_PSEUDONYM_USER_ID,
  PSEUDONYM_ADJECTIVES,
  PSEUDONYM_NOUNS,
  composeLabel,
} from '../../src/domain/model/pseudonym.js';
import type { PseudonymLabel } from '../../src/domain/model/pseudonym.js';
import { asUserId } from '../../src/domain/model/ids.js';
import type { ChatId, UserId } from '../../src/domain/model/ids.js';
import type { PseudonymStore } from '../../src/application/ports/driven/pseudonym-store.js';
import type { IdGenerator } from '../../src/application/ports/driven/id-generator.js';
import type { Clock } from '../../src/application/ports/driven/clock.js';

interface Row {
  readonly label: PseudonymLabel;
  readonly createdAt: Temporal.Instant;
}

function rowKey(chatId: ChatId, userId: number): string {
  return `${String(chatId)}:${String(userId)}`;
}

export class FakePseudonymStore implements PseudonymStore {
  readonly #rows = new Map<string, Row>();
  readonly #chats = new Set<ChatId>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async labelFor(chatId: ChatId, userId: UserId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, userId));
  }

  async labelForChat(chatId: ChatId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, CHAT_PSEUDONYM_USER_ID));
  }

  async peek(chatId: ChatId, userId: UserId): Promise<PseudonymLabel | null> {
    return await Promise.resolve(this.#rows.get(rowKey(chatId, userId))?.label ?? null);
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    this.#rows.delete(rowKey(chatId, userId));
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    const prefix = `${String(chatId)}:`;
    for (const key of [...this.#rows.keys()]) {
      if (key.startsWith(prefix)) this.#rows.delete(key);
    }
    this.#chats.delete(chatId);
    await Promise.resolve();
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const prefix = `${String(chatId)}:`;
    let deleted = 0;
    for (const [key, row] of this.#rows) {
      if (!key.startsWith(prefix)) continue;
      if (row.createdAt.epochMilliseconds < cutoff.epochMilliseconds) {
        this.#rows.delete(key);
        deleted += 1;
      }
    }
    return await Promise.resolve(deleted);
  }

  /* ---------------------------- test helpers ----------------------------- */

  knownChatIds(): readonly ChatId[] {
    return [...this.#chats];
  }

  /** Reverse lookup, as an operator would do it locally. `null` once the row is gone. */
  resolve(chatId: ChatId, label: PseudonymLabel): UserId | null {
    const prefix = `${String(chatId)}:`;
    for (const [key, row] of this.#rows) {
      if (!key.startsWith(prefix) || row.label !== label) continue;
      const userId = Number(key.slice(prefix.length));
      return userId === CHAT_PSEUDONYM_USER_ID ? null : asUserId(userId);
    }
    return null;
  }

  /* ------------------------------ internals ------------------------------ */

  #allocate(chatId: ChatId, subject: number): PseudonymLabel {
    this.#chats.add(chatId);
    const key = rowKey(chatId, subject);
    const existing = this.#rows.get(key);
    if (existing !== undefined) return existing.label;

    const taken = new Set<string>();
    const prefix = `${String(chatId)}:`;
    for (const [rowId, row] of this.#rows) {
      if (rowId.startsWith(prefix)) taken.add(row.label);
    }

    let label = composeLabel(
      this.ids.randomInt(PSEUDONYM_ADJECTIVES.length),
      this.ids.randomInt(PSEUDONYM_NOUNS.length),
    );
    let attempts = 0;
    while (taken.has(label) && attempts < 100) {
      label = composeLabel(
        this.ids.randomInt(PSEUDONYM_ADJECTIVES.length),
        this.ids.randomInt(PSEUDONYM_NOUNS.length),
      );
      attempts += 1;
    }
    this.#rows.set(key, { label, createdAt: this.clock.now() });
    return label;
  }
}
