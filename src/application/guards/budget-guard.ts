/**
 * The global USD budget hard stop (DESIGN §9): "a global USD budget; when the
 * budget trips the bot refuses everything until midnight. This is the only
 * control that bounds actual liability — a hard stop, not a warning."
 *
 * Reads `GlobalUsageStore.costMicrosSince` — the deliberately cross-chat half
 * of usage accounting (DESIGN, `usage-store.ts`): this is the one guard that
 * genuinely has to see spend across every chat at once, so it reaches for the
 * differently-named port rather than a nullable `chatId`.
 *
 * `BudgetExhaustedError.report` is `true` (`src/domain/errors.ts`): unlike
 * the other guards, a budget trip is worth an operator knowing about even
 * though it is also a normal, expected "refused" outcome for the caller — the
 * guarded pipeline (`guarded-pipeline.ts`) is the one that reports it, since
 * that is where the `ErrorReporter` port is wired in.
 */
import { BudgetExhaustedError } from '../../domain/errors.js';
import { usdToMicros } from '../../domain/cost.js';
import type { Temporal } from '../../domain/time/temporal.js';
import { startOfUtcDay } from './daily-cap-guard.js';
import type { GlobalUsageStore } from '../ports/driven/usage-store.js';

/**
 * Throws `BudgetExhaustedError` when today's global spend already meets or
 * exceeds `globalDailyBudgetUsd`. A budget of `0` is a valid, if extreme,
 * configuration — it refuses every call, which is exactly what "hard stop"
 * has to mean at the limit.
 */
export async function assertUnderGlobalBudget(
  globalUsage: GlobalUsageStore,
  now: Temporal.Instant,
  globalDailyBudgetUsd: number,
): Promise<void> {
  const since = startOfUtcDay(now);
  const spentMicros = await globalUsage.costMicrosSince(since);
  const budgetMicros = usdToMicros(globalDailyBudgetUsd);
  if (spentMicros >= budgetMicros) {
    throw new BudgetExhaustedError(globalDailyBudgetUsd);
  }
}
