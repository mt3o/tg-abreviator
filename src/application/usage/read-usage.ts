/**
 * `ReadUsage` (DESIGN §2, §3, §9, §11) — `/tldr stats`.
 *
 * Two scopes read from two differently-named ports on purpose (DESIGN,
 * `usage-store.ts`): `chat` reads `UsageStore.summarize` (real display names
 * are fine in-chat), `global` reads the deliberately cross-chat
 * `GlobalUsageStore.summarizeGlobal` (aggregates only, no identities).
 *
 * `budgetRemainingMicros` always reflects *today's* headroom against
 * `guards.globalDailyBudgetUsd` — a config value with no chat override, since
 * the budget is global by construction (DESIGN §9) — regardless of which
 * scope or `since`/`until` window the caller asked to see, because "how much
 * of today's budget is left" is a single fact, not one the query window
 * should be able to change.
 *
 * Tier enforcement (`chat admin` for a chat's own stats, `operator` for
 * global) is the dispatcher's job (WS6, `requireTier()`) before this use case
 * is ever called — DESIGN §2 states the tiers, but nothing about *reading
 * aggregates* needs the tier itself, so this use case does not re-derive it.
 */
import { usdToMicros } from '../../domain/cost.js';
import { startOfUtcDay } from '../guards/daily-cap-guard.js';
import type { Clock } from '../ports/driven/clock.js';
import type { Config } from '../ports/driven/config.js';
import type { GlobalUsageStore, UsageStore } from '../ports/driven/usage-store.js';
import type {
  ReadUsage,
  ReadUsageQuery,
  ReadUsageResult,
} from '../ports/driving/read-usage.js';

export interface ReadUsageDeps {
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
  readonly config: Config;
  readonly clock: Clock;
}

export class ReadUsageUseCase implements ReadUsage {
  readonly #deps: ReadUsageDeps;

  constructor(deps: ReadUsageDeps) {
    this.#deps = deps;
  }

  async execute(query: ReadUsageQuery): Promise<ReadUsageResult> {
    const { usage, globalUsage, config, clock } = this.#deps;

    const summary =
      query.scope.kind === 'chat'
        ? await usage.summarize(query.scope.chatId, query.since, query.until)
        : await globalUsage.summarizeGlobal(query.since, query.until);

    const now = clock.now();
    const since = startOfUtcDay(now);
    const spentMicros = await globalUsage.costMicrosSince(since);
    const budgetMicros = usdToMicros(config.get('guards').globalDailyBudgetUsd);
    const budgetRemainingMicros = budgetMicros - spentMicros;

    return { scope: query.scope, summary, budgetRemainingMicros };
  }
}
