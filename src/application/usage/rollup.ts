/**
 * Aggregate usage rollups (DESIGN §4): "`usage_events` is a per-call event
 * log, which is a richer personal-data artifact than a daily rollup...
 * derive long-lived stats from periodic aggregate rollups carrying no
 * `user_id`."
 *
 * `usage_events` carries the **same TTL as messages** (DESIGN §4) — short,
 * typically 30 days — so any statistic meant to outlive that window has to be
 * computed *before* the sweeper deletes the rows it is built from, and
 * persisted somewhere the TTL does not reach. `UsageSummary` (`byModel`
 * aggregates, no `user_id`, no row-level detail) is already exactly the
 * carries-no-identity shape DESIGN asks for — `UsageStore.summarize` /
 * `GlobalUsageStore.summarizeGlobal` compute it directly. What this module
 * adds is the *job*: enumerate every chat (`MaintenanceStore`, the same port
 * the TTL sweeper uses to know what to iterate), compute one rollup per chat
 * plus one global rollup, and hand each to a `sink` — a caller-supplied
 * destination (a log line, a file, a future rollup table) rather than a new
 * store port, since Phase 0 defined no such port and this workstream does not
 * get to invent one.
 */
import type { ChatId } from '../../domain/model/ids.js';
import type { Temporal } from '../../domain/time/temporal.js';
import type { UsageSummary } from '../../domain/model/usage.js';
import type { MaintenanceStore } from '../ports/driven/maintenance-store.js';
import type { GlobalUsageStore, UsageStore } from '../ports/driven/usage-store.js';

export type UsageRollupScope = { readonly kind: 'chat'; readonly chatId: ChatId } | { readonly kind: 'global' };

export interface UsageRollup {
  readonly scope: UsageRollupScope;
  readonly summary: UsageSummary;
  /** When this rollup was computed — not the window it covers (`summary.since`/`until`). */
  readonly computedAt: Temporal.Instant;
}

/** Where a computed rollup goes. Deliberately not a `UsageStore` — see module docs. */
export interface UsageRollupSink {
  publish(rollup: UsageRollup): Promise<void>;
}

export interface RunUsageRollupDeps {
  readonly maintenance: MaintenanceStore;
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
}

export interface UsageRollupWindow {
  readonly since: Temporal.Instant;
  readonly until: Temporal.Instant;
}

/**
 * Computes one rollup per known chat plus one global rollup covering
 * `window`, publishing each to `sink` as it is computed, and returns every
 * rollup produced (in the order published) for a caller that also wants to
 * log a total.
 *
 * A chat that has made zero calls in `window` still produces a rollup (an
 * all-zero `UsageSummary`) — silently skipping it would make "the chat was
 * quiet" indistinguishable from "the job never ran for this chat".
 */
export async function runUsageRollup(
  deps: RunUsageRollupDeps,
  window: UsageRollupWindow,
  sink: UsageRollupSink,
  computedAt: Temporal.Instant,
): Promise<readonly UsageRollup[]> {
  const { maintenance, usage, globalUsage } = deps;
  const rollups: UsageRollup[] = [];

  const chatIds = await maintenance.listChatIds();
  for (const chatId of chatIds) {
    const summary = await usage.summarize(chatId, window.since, window.until);
    const rollup: UsageRollup = { scope: { kind: 'chat', chatId }, summary, computedAt };
    rollups.push(rollup);
    await sink.publish(rollup);
  }

  const globalSummary = await globalUsage.summarizeGlobal(window.since, window.until);
  const globalRollup: UsageRollup = { scope: { kind: 'global' }, summary: globalSummary, computedAt };
  rollups.push(globalRollup);
  await sink.publish(globalRollup);

  return rollups;
}

/** An in-memory `UsageRollupSink`, useful as a default before a real destination exists. */
export class InMemoryUsageRollupSink implements UsageRollupSink {
  readonly published: UsageRollup[] = [];

  async publish(rollup: UsageRollup): Promise<void> {
    this.published.push(rollup);
    await Promise.resolve();
  }
}
