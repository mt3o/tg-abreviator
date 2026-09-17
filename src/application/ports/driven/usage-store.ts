/**
 * `UsageStore` — the per-call event log (DESIGN §4, §9).
 *
 * `usage_events` is a richer personal-data artifact than a daily rollup, so
 * (DESIGN §4) it stores only the question *hash*, carries the same TTL as
 * messages, and long-lived statistics come from rollups with no user reference.
 *
 * `chatId` is the required first parameter of every method (DESIGN §6.1).
 * The one genuinely cross-chat query the design requires — the **global** daily
 * USD budget (DESIGN §9) and operator-wide stats (DESIGN §2) — lives on a
 * separate port below rather than as a nullable `chatId` on this one. An
 * accidental cross-chat read should not be one forgotten argument away; it
 * should require reaching for a differently named port that returns aggregates
 * only, never rows.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { UsageEvent, UsageSummary } from '../../../domain/model/usage.js';

export interface UsageStore {
  /** Append-only. `unit_prices_json` is written per row (DESIGN §4). */
  record(chatId: ChatId, event: UsageEvent): Promise<void>;

  /** Backs the per-chat daily call cap (DESIGN §9). */
  countCalls(chatId: ChatId, since: Temporal.Instant, until: Temporal.Instant): Promise<number>;

  /** Backs in-chat `/tldr stats`, which may use real display names (DESIGN §11). */
  summarize(
    chatId: ChatId,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<UsageSummary>;

  /**
   * `/forgetme` (DESIGN §5): replace the user's id with a **freshly generated
   * random token** from `IdGenerator`, stored nowhere else. Not a hash — user
   * ids are a small enumerable integer space, so a deterministic hash is
   * re-linkable and therefore not erasure.
   *
   * Returns the number of rows rewritten. The caller supplies the token so the
   * store owns no randomness.
   */
  anonymiseUser(chatId: ChatId, userId: UserId, token: string): Promise<number>;

  /** TTL sweep for one chat: same schedule as messages (DESIGN §4). */
  deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number>;

  deleteChat(chatId: ChatId): Promise<number>;
}

/**
 * The deliberately cross-chat half. Aggregates only — no rows, no user
 * references, no chat breakdown beyond a count.
 *
 * DESIGN §9: the global USD budget "is the only control that bounds actual
 * liability — a hard stop, not a warning", and it cannot be evaluated one chat
 * at a time.
 */
export interface GlobalUsageStore {
  /** Total spend across every chat since `since`, in millionths of a USD. */
  costMicrosSince(since: Temporal.Instant): Promise<number>;

  /** Operator-global `/tldr stats` (DESIGN §2). Carries no identities. */
  summarizeGlobal(since: Temporal.Instant, until: Temporal.Instant): Promise<UsageSummary>;
}
