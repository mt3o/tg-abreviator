/**
 * The TTL sweeper (DESIGN §5).
 *
 * "Rolling TTL. Global default 30d, per-chat override in config, hard cap in
 * env. Nothing can set 'forever' without a redeploy." That sentence is only
 * true if something actually deletes, and this is that something. Without it
 * the bot is a permanent transcript of a chat that believes itself ephemeral,
 * which is the exact thing DESIGN §5 exists to prevent.
 *
 * Every store's delete method is chat-scoped by construction (DESIGN §6.1),
 * which leaves a sweeper with nothing to iterate over — hence
 * `MaintenanceStore.listChatIds()`, the one deliberate "list every chat"
 * operation in the codebase.
 *
 * Four things expire on the same schedule, and the order is deliberate:
 *
 * 1. **Chunks first.** A cached summary must never outlive the messages it
 *    summarizes (DESIGN §5). `deleteExpired` decides that by looking at the
 *    newest message a chunk covers, so it wants those rows still present —
 *    it also catches chunks whose messages are already gone, but running it
 *    first means the common case is decided on evidence rather than absence.
 * 2. **Messages.**
 * 3. **`usage_events`**, which DESIGN §4 gives "the same TTL as messages"
 *    because a per-call event log is a richer personal-data artifact than a
 *    daily rollup.
 * 4. **Pseudonyms**, expired on the same schedule (DESIGN §11) so an external
 *    label stops resolving when the data behind it is gone.
 *
 * The TTL itself is read from the **global** config, never the per-chat
 * derived view: DESIGN §2 makes retention operator-only, because "a group
 * admin extending retention would be doing it to *other people's* messages".
 * The hard cap is applied here as well as in cross-validation — belt and
 * braces on the one number that bounds how long anything can be kept.
 */
import type { ChatId } from '../../domain/model/ids.js';
import type { ChunkStore } from '../ports/driven/chunk-store.js';
import type { Clock } from '../ports/driven/clock.js';
import type { Config } from '../ports/driven/config.js';
import type { MaintenanceStore } from '../ports/driven/maintenance-store.js';
import type { MessageStore } from '../ports/driven/message-store.js';
import type { PseudonymStore } from '../ports/driven/pseudonym-store.js';
import type { UsageStore } from '../ports/driven/usage-store.js';

export interface SweepExpiredDeps {
  readonly maintenance: MaintenanceStore;
  readonly messages: MessageStore;
  readonly chunks: ChunkStore;
  readonly usage: UsageStore;
  readonly pseudonyms: PseudonymStore;
  readonly config: Config;
  readonly clock: Clock;
}

export interface SweepExpiredResult {
  readonly chatsSwept: number;
  readonly messagesDeleted: number;
  readonly chunksDeleted: number;
  readonly usageRowsDeleted: number;
  readonly pseudonymsDeleted: number;
}

export class SweepExpiredUseCase {
  readonly #deps: SweepExpiredDeps;

  constructor(deps: SweepExpiredDeps) {
    this.#deps = deps;
  }

  /** The retention window for one chat, in days, never above the hard cap. */
  #ttlDaysFor(chatId: ChatId): number {
    const retention = this.#deps.config.get('retention');
    const perChat = retention.perChatTtlDays[String(chatId)];
    return Math.min(perChat ?? retention.ttlDays, retention.hardCapDays);
  }

  async execute(): Promise<SweepExpiredResult> {
    const { maintenance, messages, chunks, usage, pseudonyms, clock } = this.#deps;
    const now = clock.now();

    let messagesDeleted = 0;
    let chunksDeleted = 0;
    let usageRowsDeleted = 0;
    let pseudonymsDeleted = 0;

    const chatIds = await maintenance.listChatIds();
    for (const chatId of chatIds) {
      // `Temporal.Instant` arithmetic takes no calendar units, and that is
      // correct here rather than a workaround: retention is an elapsed-time
      // promise ("kept for 30 days"), not a wall-clock-calendar one, so it
      // must not shift by an hour twice a year.
      const cutoff = now.subtract({ hours: this.#ttlDaysFor(chatId) * 24 });

      chunksDeleted += await chunks.deleteExpired(chatId, cutoff);
      messagesDeleted += await messages.deleteOlderThan(chatId, cutoff);
      usageRowsDeleted += await usage.deleteOlderThan(chatId, cutoff);
      pseudonymsDeleted += await pseudonyms.deleteOlderThan(chatId, cutoff);
    }

    return {
      chatsSwept: chatIds.length,
      messagesDeleted,
      chunksDeleted,
      usageRowsDeleted,
      pseudonymsDeleted,
    };
  }
}

/** Exported for the composition root's scheduler: minutes → milliseconds. */
export function sweepIntervalMs(sweepIntervalMinutes: number): number {
  return sweepIntervalMinutes * 60_000;
}
