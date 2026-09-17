/**
 * Usage accounting (DESIGN §4 `usage_events`, §7, §9).
 *
 * `usage_events` is a per-call event log, which is a richer personal-data
 * artifact than a daily rollup. So (DESIGN §4): only the question *hash* is
 * stored, never the text; it carries the same TTL as messages; and long-lived
 * statistics come from aggregate rollups that carry no user reference at all.
 */
import type { Temporal } from '../time/temporal.js';
import type { ChatId, ThreadId, UsageEventId, UserId } from './ids.js';

/**
 * Which call this was. `Llm.complete()` returns usage on **every** call,
 * map-phase included, so this is always known rather than guessed.
 */
export type UsagePhase =
  /** A single-shot summarize/answer, no compaction. */
  | 'single'
  /** Map phase: one chunk, on the cheap model (DESIGN §7). */
  | 'map'
  /** Reduce phase: the final answer, on the strong model. */
  | 'reduce'
  /** `messages.count_tokens` — billed at zero, recorded for the audit trail. */
  | 'count_tokens'
  /** A 👍/👎 press (DESIGN §12). Carries no tokens and no cost. */
  | 'feedback';

export type UsageStatus =
  | 'ok'
  | 'error'
  | 'refused'
  | 'over_budget'
  /** Served from the dedupe cache (DESIGN §9): no provider call, no cost. */
  | 'cached'
  | 'thumbs_up'
  | 'thumbs_down';

/**
 * $ per million tokens, as configured at the moment of the call.
 *
 * Stored per row (`unit_prices_json`) so that editing the config price table
 * does not silently rewrite last month's history (DESIGN §4).
 */
export interface UnitPrices {
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
  readonly cacheReadPerMTokUsd: number;
}

/**
 * Who the call belonged to.
 *
 * DESIGN §5: `/forgetme` replaces the user id with a **freshly generated random
 * token, stored nowhere else** — not a hash of the id, because Telegram user ids
 * are a small enumerable integer space and a deterministic hash is re-linkable
 * and therefore not erasure. The union makes the two states impossible to
 * confuse, and the `usage_events.user_id` column is TEXT to hold either.
 */
export type UserRef =
  | { readonly kind: 'user'; readonly userId: UserId }
  | { readonly kind: 'anonymised'; readonly token: string };

export function userRef(userId: UserId): UserRef {
  return { kind: 'user', userId };
}

export function anonymisedRef(token: string): UserRef {
  return { kind: 'anonymised', token };
}

export interface UsageEvent {
  readonly id: UsageEventId;
  readonly ts: Temporal.Instant;
  readonly chatId: ChatId;
  readonly threadId: ThreadId | null;
  readonly user: UserRef;
  /** Concrete provider model id, not the alias — aliases get repointed. */
  readonly model: string;
  readonly phase: UsagePhase;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cost in millionths of a USD. Integer arithmetic; no floats in the ledger. */
  readonly costMicros: number;
  readonly unitPrices: UnitPrices;
  /** The raw range token as typed (`-50`, `2h`), or the empty string. */
  readonly rangeSpec: string;
  /** sha256 of the normalized question (DESIGN §9). Never the text. `null` when summarizing. */
  readonly questionHash: string | null;
  readonly status: UsageStatus;
}

/** Aggregate view for `/tldr stats`. Carries no user reference. */
export interface UsageSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly since: Temporal.Instant;
  readonly until: Temporal.Instant;
  /** Per concrete model id. */
  readonly byModel: Readonly<Record<string, UsageModelSummary>>;
}

export interface UsageModelSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}
