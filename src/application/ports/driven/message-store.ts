/**
 * `MessageStore` — persistence for the corpus (DESIGN §3, §4).
 *
 * **`chatId` is the required first parameter of every method.** DESIGN §6.1:
 * "Never cross chats … A leak here is the worst failure this bot can have; make
 * it structurally impossible rather than remembered." Implementations must also
 * reject a `StoredMessage` whose own `chatId` disagrees with the argument — the
 * port-conformance suite asserts it.
 *
 * Ordering: every method that returns rows returns them **ascending by
 * `(ts, messageId)`** (see `compareMessages`). Synthetic gap-marker rows carry
 * negative ids but real timestamps, so message id alone would misplace them.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, MessageId, ThreadId, UserId } from '../../../domain/model/ids.js';
import type { MessageKind, StoredMessage } from '../../../domain/model/message.js';
import type { ResolvedRange } from '../../../domain/model/range.js';
import type { Scope } from '../../../domain/model/scope.js';

/**
 * Filters applied **before** the range's `limit` and before `lastN` counting,
 * so that `-50` means fifty messages the user can actually see.
 *
 * DESIGN §6.3: opt-out filtering happens at query time, not in the prompt.
 * DESIGN §6.4: the bot's own messages are excluded from the corpus — pass the
 * bot's user id here rather than relying on it never having been stored.
 */
export interface MessageQueryOptions {
  readonly excludeUserIds?: readonly UserId[];
  /** Typically `NON_HUMAN_MESSAGE_KINDS` (DESIGN §2: `-N` counts human messages). */
  readonly excludeKinds?: readonly MessageKind[];
}

/** A hole in the corpus after downtime (DESIGN §4). The store allocates the id. */
export interface GapMarkerInput {
  readonly threadId: ThreadId | null;
  /** When the gap ended — i.e. when the bot came back. */
  readonly ts: Temporal.Instant;
  /** Optional human-readable note; the renderer supplies the user-facing wording. */
  readonly text: string | null;
}

export interface MessageStore {
  /**
   * Insert or replace on `(chat_id, message_id)`. Idempotent: a replayed update
   * and an `edited_message` both land here, and an edit updates in place —
   * otherwise you summarize retracted claims (DESIGN §4).
   */
  upsert(chatId: ChatId, message: StoredMessage): Promise<void>;

  /** Same contract as `upsert`, applied atomically. */
  upsertMany(chatId: ChatId, messages: readonly StoredMessage[]): Promise<void>;

  findById(chatId: ChatId, messageId: MessageId): Promise<StoredMessage | null>;

  /**
   * Materialise the range. Honours `range.scope`, `range.start`, `range.end`,
   * `range.limit` and `options`, and returns rows in canonical order.
   *
   * Precisely:
   *
   * 1. keep rows matching `scope` and `options`;
   * 2. keep rows with `ts <= range.end`;
   * 3. apply `start` —
   *    `instant`: `ts >= start.ts`;
   *    `message`: the row-value comparison `(ts, messageId)` against the anchor
   *    row, `>=` when `inclusive` and `>` otherwise. The anchor is looked up in
   *    this chat; if it is not there, throw `AnchorNotFoundError` rather than
   *    guessing — the caller turns that into "I never saw that message";
   *    `lastN`: keep the newest `count` of what survived;
   * 4. apply `range.limit`, keeping the **newest** rows, because a range is
   *    always anchored at now (DESIGN §2).
   *
   * The `message` case compares `(ts, messageId)` rather than `messageId` alone
   * so that synthetic gap-marker rows — negative ids, real timestamps — land
   * inside a reply-anchored range instead of falling out of every one of them.
   */
  fetchRange(
    chatId: ChatId,
    range: ResolvedRange,
    options?: MessageQueryOptions,
  ): Promise<readonly StoredMessage[]>;

  /**
   * How many rows match the range, without materialising any of them.
   *
   * Separate from `fetchRange` on purpose: the guards check size *before*
   * anything is loaded or tokenized, so a 40k-message range is refused rather
   * than read.
   *
   * **`range.limit` is deliberately ignored here.** The limit is a safety cap on
   * what gets sent to a model; the count is the true size of what the user
   * asked for, which is what a guard needs in order to say "that is 12,000
   * messages, narrow it down". Everything else — scope, `start` (including a
   * `lastN` count), `end` and `options` — applies exactly as in `fetchRange`.
   */
  countInRange(
    chatId: ChatId,
    range: ResolvedRange,
    options?: MessageQueryOptions,
  ): Promise<number>;

  /** Most recent stored row in scope, or `null`. */
  newest(chatId: ChatId, scope: Scope): Promise<StoredMessage | null>;

  /**
   * Oldest stored row in scope, or `null`. This is the corpus horizon: a range
   * reaching past it is clamped and the answer says so (DESIGN §7).
   */
  oldest(chatId: ChatId, scope: Scope): Promise<StoredMessage | null>;

  /** Total rows in scope. Backs "mam 340 wiadomości od 17.09" (PLAN, M1). */
  countAll(chatId: ChatId, scope: Scope): Promise<number>;

  /** Allocates a synthetic (negative) message id and returns the inserted row. */
  insertGapMarker(chatId: ChatId, marker: GapMarkerInput): Promise<StoredMessage>;

  /**
   * `/forgetme` (DESIGN §5). Returns the ids that were deleted so the caller can
   * delete every chunk whose `[first, last]` range overlaps one of them —
   * without that cascade, erasure is theatre.
   */
  deleteByUser(chatId: ChatId, userId: UserId): Promise<readonly MessageId[]>;

  /** TTL sweep for one chat. Returns the number of rows deleted. */
  deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number>;

  /** `/forget` (DESIGN §2): wipe the whole chat log. Returns rows deleted. */
  deleteChat(chatId: ChatId): Promise<number>;
}
