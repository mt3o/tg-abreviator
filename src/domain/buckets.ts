/**
 * Deterministic chunking primitives for map-reduce compaction (DESIGN §7,
 * "Compaction").
 *
 * "**Chunk boundaries must be deterministic** or the cache never hits and two
 * calls a minute apart produce differently-shaped summaries. **Hybrid
 * bucketing**: time buckets (6h, in the chat's timezone) subdivided
 * deterministically by count when a bucket exceeds the token threshold. Time
 * buckets also fall on natural conversational seams (overnight gaps), which
 * makes summaries read better."
 *
 * Three pure building blocks live here, each usable on its own and composed by
 * `src/application/compaction/**`:
 *
 * - `bucketByTime` — the 6h grid, aligned to local midnight in the chat's zone.
 *   It depends only on each message's own timestamp, never on the batch as a
 *   whole, which is exactly what makes it deterministic: a message arriving
 *   later never reshapes a bucket that was already complete (see the
 *   determinism test in `buckets.test.ts`).
 * - `groupByWeight` — a generic, order-preserving greedy bin-fill. Used both to
 *   subdivide an over-threshold time bucket by (approximate) size, and to group
 *   already-compacted chunks into the next reduce round. It never calls the
 *   real tokenizer itself — that is I/O and belongs to `Llm.countTokens` in the
 *   application layer (DESIGN §7: never estimate the tokens that get billed).
 *   The `weightOf` callback here is a caller-supplied, deterministic shaping
 *   heuristic only; the actual per-call usage that lands in `usage_events`
 *   always comes back from `Llm.complete()`, never from this function.
 * - `partitionByKey` — a stable, order-preserving partition, used to keep a
 *   forum's topics from bleeding into one another inside a single chunk when a
 *   range is `all`-scoped (DESIGN §2, "Scope").
 */
import { InvalidValueError } from './errors.js';
import { Temporal } from './time/temporal.js';
import type { TimeZoneId } from './time/temporal.js';
import { compareMessages } from './model/message.js';
import type { StoredMessage } from './model/message.js';

/** DESIGN §7: "time buckets (6h, in the chat's timezone)". */
export const DEFAULT_BUCKET_HOURS = 6;

/** One 6h-aligned (or `bucketHours`-aligned) window and the messages that fell in it. */
export interface TimeBucket {
  /** Inclusive lower edge, wall-clock-aligned in the chat's zone. */
  readonly start: Temporal.ZonedDateTime;
  /** Exclusive upper edge. */
  readonly end: Temporal.ZonedDateTime;
  /** In canonical order (`compareMessages`). Never empty. */
  readonly messages: readonly StoredMessage[];
}

export interface BucketingOptions {
  readonly timeZone: TimeZoneId;
  /** Must evenly divide 24. Defaults to `DEFAULT_BUCKET_HOURS`. */
  readonly bucketHours?: number;
}

/** The bucketHours-aligned slot a zoned instant falls into, from local midnight. */
function bucketStart(zoned: Temporal.ZonedDateTime, bucketHours: number): Temporal.ZonedDateTime {
  const slot = Math.floor(zoned.hour / bucketHours) * bucketHours;
  return zoned.startOfDay().add({ hours: slot });
}

/**
 * Groups messages into consecutive, non-overlapping windows of `bucketHours`
 * hours, aligned to local midnight in `options.timeZone`. Each bucket's
 * boundary is a pure function of a message's own timestamp — never of the
 * earliest or latest message in the whole set — which is what makes a
 * previously-completed bucket immune to a message that arrives later
 * (DESIGN, WS11 DoD: "the same range computed twice, with a new message
 * arriving in between, yields identical boundaries for all completed
 * buckets").
 *
 * Input need not be pre-sorted; the output always is (by `compareMessages`),
 * and buckets are returned in chronological order.
 */
export function bucketByTime(
  messages: readonly StoredMessage[],
  options: BucketingOptions,
): readonly TimeBucket[] {
  const bucketHours = options.bucketHours ?? DEFAULT_BUCKET_HOURS;
  if (bucketHours <= 0 || 24 % bucketHours !== 0) {
    throw new InvalidValueError(
      `bucketHours must be a positive divisor of 24, got ${String(bucketHours)}`,
    );
  }
  if (messages.length === 0) return [];

  const sorted = [...messages].sort(compareMessages);
  const buckets: { start: Temporal.ZonedDateTime; end: Temporal.ZonedDateTime; messages: StoredMessage[] }[] =
    [];

  for (const message of sorted) {
    const zoned = message.ts.toZonedDateTimeISO(options.timeZone);
    const start = bucketStart(zoned, bucketHours);
    const last = buckets[buckets.length - 1];
    if (last === undefined || Temporal.ZonedDateTime.compare(start, last.start) !== 0) {
      buckets.push({ start, end: start.add({ hours: bucketHours }), messages: [message] });
    } else {
      last.messages.push(message);
    }
  }

  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    messages: bucket.messages,
  }));
}

/**
 * Order-preserving greedy bin-fill: walks `items` once, closing the current
 * group and starting a new one whenever adding the next item would push the
 * running weight over `maxWeight`. Every group holds at least one item — an
 * item heavier than `maxWeight` on its own still gets a (oversized) group of
 * one, so the function always makes progress and never loops.
 *
 * Deterministic and total: the same `items` (in the same order) and the same
 * `weightOf` always produce the same grouping, which is the property the
 * chunk cache depends on (DESIGN §7).
 */
export function groupByWeight<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  maxWeight: number,
): readonly (readonly T[])[] {
  if (maxWeight <= 0) {
    throw new InvalidValueError(`maxWeight must be positive, got ${String(maxWeight)}`);
  }
  if (items.length === 0) return [];

  const groups: T[][] = [];
  let current: T[] = [];
  let currentWeight = 0;

  for (const item of items) {
    const weight = weightOf(item);
    if (current.length > 0 && currentWeight + weight > maxWeight) {
      groups.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(item);
    currentWeight += weight;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Stable partition: every item goes into the group named by `keyOf(item)`,
 * groups appear in the order their key was first seen, and relative order
 * within a group is preserved. Used to keep threads apart before bucketing an
 * `all`-scoped range, so one chunk never silently spans two forum topics.
 */
export function partitionByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly (readonly T[])[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(item);
  }
  return order.map((key) => groups.get(key) as T[]);
}
