/**
 * In-memory `MessageStore`.
 *
 * Every rule the port states is implemented here, not approximated, because
 * this fake and WS1's SQLite adapter are checked by the *same* conformance
 * suite: if they disagree, one of them is wrong and the suite says which.
 */
import { Temporal } from '../../src/domain/time/temporal.js';
import { AnchorNotFoundError, InvalidValueError } from '../../src/domain/errors.js';
import { compareMessages } from '../../src/domain/model/message.js';
import { scopeMatches } from '../../src/domain/model/scope.js';
import { asMessageId } from '../../src/domain/model/ids.js';
import type { ChatId, MessageId, UserId } from '../../src/domain/model/ids.js';
import type { StoredMessage } from '../../src/domain/model/message.js';
import type { ResolvedRange } from '../../src/domain/model/range.js';
import type { Scope } from '../../src/domain/model/scope.js';
import type {
  GapMarkerInput,
  MessageQueryOptions,
  MessageStore,
} from '../../src/application/ports/driven/message-store.js';

export class FakeMessageStore implements MessageStore {
  /** chatId -> messageId -> row. */
  readonly #rows = new Map<ChatId, Map<MessageId, StoredMessage>>();
  /** Next synthetic (negative) id, per chat. */
  readonly #nextSynthetic = new Map<ChatId, number>();

  /* ------------------------------- writes -------------------------------- */

  async upsert(chatId: ChatId, message: StoredMessage): Promise<void> {
    this.#assertSameChat(chatId, message);
    this.#chat(chatId).set(message.messageId, message);
    await Promise.resolve();
  }

  async upsertMany(chatId: ChatId, messages: readonly StoredMessage[]): Promise<void> {
    for (const message of messages) this.#assertSameChat(chatId, message);
    for (const message of messages) this.#chat(chatId).set(message.messageId, message);
    await Promise.resolve();
  }

  async insertGapMarker(chatId: ChatId, marker: GapMarkerInput): Promise<StoredMessage> {
    const next = (this.#nextSynthetic.get(chatId) ?? 0) - 1;
    this.#nextSynthetic.set(chatId, next);
    const row: StoredMessage = {
      chatId,
      messageId: asMessageId(next),
      threadId: marker.threadId,
      userId: null,
      displayName: null,
      ts: marker.ts,
      replyToMessageId: null,
      kind: 'gap_marker',
      text: marker.text,
    };
    this.#chat(chatId).set(row.messageId, row);
    return await Promise.resolve(row);
  }

  /* ------------------------------- reads --------------------------------- */

  async findById(chatId: ChatId, messageId: MessageId): Promise<StoredMessage | null> {
    return await Promise.resolve(this.#chat(chatId).get(messageId) ?? null);
  }

  async fetchRange(
    chatId: ChatId,
    range: ResolvedRange,
    options: MessageQueryOptions = {},
  ): Promise<readonly StoredMessage[]> {
    const matched = this.#matching(chatId, range, options);
    return await Promise.resolve(
      matched.length > range.limit ? matched.slice(matched.length - range.limit) : matched,
    );
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
    const rows = this.#inScope(chatId, scope);
    return await Promise.resolve(rows.at(-1) ?? null);
  }

  async oldest(chatId: ChatId, scope: Scope): Promise<StoredMessage | null> {
    const rows = this.#inScope(chatId, scope);
    return await Promise.resolve(rows.at(0) ?? null);
  }

  async countAll(chatId: ChatId, scope: Scope): Promise<number> {
    return await Promise.resolve(this.#inScope(chatId, scope).length);
  }

  /* ------------------------------ deletions ------------------------------ */

  async deleteByUser(chatId: ChatId, userId: UserId): Promise<readonly MessageId[]> {
    const chat = this.#chat(chatId);
    const deleted: MessageId[] = [];
    for (const [messageId, row] of chat) {
      if (row.userId === userId) {
        chat.delete(messageId);
        deleted.push(messageId);
      }
    }
    deleted.sort((a, b) => a - b);
    return await Promise.resolve(deleted);
  }

  async deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number> {
    const chat = this.#chat(chatId);
    let deleted = 0;
    for (const [messageId, row] of chat) {
      if (Temporal.Instant.compare(row.ts, cutoff) < 0) {
        chat.delete(messageId);
        deleted += 1;
      }
    }
    return await Promise.resolve(deleted);
  }

  async deleteChat(chatId: ChatId): Promise<number> {
    const deleted = this.#chat(chatId).size;
    this.#rows.delete(chatId);
    this.#nextSynthetic.delete(chatId);
    return await Promise.resolve(deleted);
  }

  /* ---------------------------- test helpers ----------------------------- */

  /** Backs `FakeMaintenanceStore`. */
  knownChatIds(): readonly ChatId[] {
    return [...this.#rows.keys()];
  }

  /** Everything stored for a chat, in canonical order. */
  dump(chatId: ChatId): readonly StoredMessage[] {
    return [...this.#chat(chatId).values()].sort(compareMessages);
  }

  /* ------------------------------ internals ------------------------------ */

  #chat(chatId: ChatId): Map<MessageId, StoredMessage> {
    let chat = this.#rows.get(chatId);
    if (chat === undefined) {
      chat = new Map<MessageId, StoredMessage>();
      this.#rows.set(chatId, chat);
    }
    return chat;
  }

  #assertSameChat(chatId: ChatId, message: StoredMessage): void {
    if (message.chatId !== chatId) {
      // DESIGN §6.1: never cross chats. Structurally impossible beats remembered.
      throw new InvalidValueError(
        `message belongs to chat ${String(message.chatId)}, not ${String(chatId)}`,
      );
    }
  }

  #inScope(chatId: ChatId, scope: Scope): StoredMessage[] {
    return [...this.#chat(chatId).values()]
      .filter((row) => scopeMatches(scope, row.threadId))
      .sort(compareMessages);
  }

  #matching(
    chatId: ChatId,
    range: ResolvedRange,
    options: MessageQueryOptions,
  ): StoredMessage[] {
    const excludedUsers = new Set<UserId>(options.excludeUserIds ?? []);
    const excludedKinds = new Set<string>(options.excludeKinds ?? []);

    let rows = this.#inScope(chatId, range.scope)
      .filter((row) => Temporal.Instant.compare(row.ts, range.end) <= 0)
      .filter((row) => row.userId === null || !excludedUsers.has(row.userId))
      .filter((row) => !excludedKinds.has(row.kind));

    const start = range.start;
    switch (start.kind) {
      case 'instant': {
        rows = rows.filter((row) => Temporal.Instant.compare(row.ts, start.ts) >= 0);
        break;
      }
      case 'message': {
        const anchor = this.#chat(chatId).get(start.messageId);
        if (anchor === undefined) throw new AnchorNotFoundError();
        rows = rows.filter((row) => {
          const cmp = compareMessages(row, anchor);
          return start.inclusive ? cmp >= 0 : cmp > 0;
        });
        break;
      }
      case 'lastN': {
        if (rows.length > start.count) rows = rows.slice(rows.length - start.count);
        break;
      }
    }
    return rows;
  }
}
