/**
 * `ReadUsage` — `/tldr stats` (DESIGN §2, §3, §11).
 *
 * Two scopes, and the difference matters for privacy, not just for filtering:
 *
 * - **chat** — chat-admin tier, their own chat. Rendered with real display
 *   names: everyone in that chat can already see who is there, and a pseudonym
 *   would just be friction (DESIGN §11).
 * - **global** — operator tier. Aggregates only, no identities at all.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { UsageSummary } from '../../../domain/model/usage.js';

export type UsageScope =
  | { readonly kind: 'chat'; readonly chatId: ChatId }
  | { readonly kind: 'global' };

export interface ReadUsageQuery {
  readonly scope: UsageScope;
  readonly since: Temporal.Instant;
  readonly until: Temporal.Instant;
  readonly requestedBy: UserId;
}

export interface ReadUsageResult {
  readonly scope: UsageScope;
  readonly summary: UsageSummary;
  /** Remaining headroom against the global daily budget (DESIGN §9). */
  readonly budgetRemainingMicros: number | null;
}

export interface ReadUsage {
  execute(query: ReadUsageQuery): Promise<ReadUsageResult>;
}
