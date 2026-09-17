/**
 * Cost arithmetic (DESIGN §4 `unit_prices_json`, §7 "Price table per model",
 * §9 "the only control that bounds actual liability").
 *
 * `UnitPrices` is `$` per **million** tokens, and `usage_events.cost_micros`
 * is millionths of a `$` — the two units are reciprocal by construction:
 *
 *   costUsd   = tokens * pricePerMTokUsd / 1_000_000
 *   costMicros = costUsd * 1_000_000
 *              = tokens * pricePerMTokUsd
 *
 * so a price of "$3 per million tokens" is exactly "3 micros per token".
 * Integer arithmetic only (DESIGN §4: "Integer arithmetic; no floats in the
 * ledger."): each token category is rounded to the nearest micro
 * independently and the components are summed, rather than rounding once at
 * the end — that keeps a component-by-component audit reproducible token
 * category by token category.
 */
import type { UnitPrices } from './model/usage.js';

/**
 * The billed token counts for one call. Mirrors `Llm`'s `LlmUsage` shape
 * (`src/application/ports/driven/llm.ts`) without importing it — the domain
 * does not import application ports, only the reverse.
 */
export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Zero in v1 (DESIGN §7: no prompt caching), but priced when it is not. */
  readonly cacheReadTokens: number;
}

function microsFor(tokens: number, pricePerMTokUsd: number): number {
  return Math.round(tokens * pricePerMTokUsd);
}

/**
 * Cost of one call, in millionths of a USD.
 *
 * `UnitPrices` carries no cache-*write* rate (DESIGN §7's price table is
 * input/output/cache-read only) because v1 never writes to the cache; a
 * `cacheWriteTokens` count on the caller's side, if ever non-zero, is simply
 * not priced here — that is a config-schema gap to close if and when caching
 * ships, not something this pure function should guess at.
 */
export function computeCostMicros(tokens: UsageTokens, prices: UnitPrices): number {
  return (
    microsFor(tokens.inputTokens, prices.inputPerMTokUsd) +
    microsFor(tokens.outputTokens, prices.outputPerMTokUsd) +
    microsFor(tokens.cacheReadTokens, prices.cacheReadPerMTokUsd)
  );
}

/** `costMicros` back to a `$` figure, for rendering `/tldr stats` (DESIGN §2). */
export function microsToUsd(costMicros: number): number {
  return costMicros / 1_000_000;
}

/** The inverse of `microsToUsd` — a configured USD budget, in micros, for comparison against a running total. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}
