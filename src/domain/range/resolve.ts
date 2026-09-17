/**
 * `resolve(rangeSpec, ctx) -> ResolvedRange` (DESIGN §2, §3).
 *
 * Turns *what the user typed* into *a concrete, queryable window*. Pure and
 * deterministic: every instant comes from `ctx.now` (the `Clock` port, read by
 * the caller), never `Temporal.Now`.
 *
 * Two responsibilities beyond picking a start:
 *
 * - **Reply-anchor fallback.** DESIGN §2: "Explicit range wins over a reply
 *   anchor when both are present." A `RangeSpec` of kind `default` means the
 *   user typed no range token; only then, if `ctx.replyAnchor` is set, does
 *   this function synthesize a `replyAnchor` spec and resolve against it
 *   (`basis: 'replyAnchor'`). Any other spec kind is what the user explicitly
 *   typed and always wins (`basis: 'explicit'`).
 * - **Horizon clamping.** A time-based start that reaches further back than
 *   the stored corpus is pulled forward to `ctx.storedHorizon` and flagged via
 *   `clampedToHorizon` — the answer must say so (DESIGN §7, §10). Message-id
 *   based starts (`lastN`, a reply anchor) have no time horizon to clamp
 *   against; that check happens against the store elsewhere.
 *
 * `Temporal.ZonedDateTime` arithmetic in the chat's IANA zone makes calendar
 * units (days, weeks, "yesterday", "this month") DST-correct: subtracting 3
 * calendar days across a fall-back transition yields 73 elapsed hours, not 72
 * (DESIGN §3).
 */
import { Temporal } from '../time/temporal.js';
import type { TimeZoneId } from '../time/temporal.js';
import {
  MAX_RANGE_MESSAGES_HARD_CAP,
  type MessageCountSpec,
  type NamedWindow,
  type RangeBasis,
  type RangeDuration,
  type RangeResolutionContext,
  type RangeSpec,
  type ReplyAnchorSpec,
  type ResolvedRange,
} from '../model/range.js';

/** `resolve(rangeSpec, ctx) -> ResolvedRange` (DESIGN §3). */
export function resolve(spec: RangeSpec, ctx: RangeResolutionContext): ResolvedRange {
  if (spec.kind === 'default' && ctx.replyAnchor !== null) {
    const anchorSpec: ReplyAnchorSpec = { kind: 'replyAnchor', raw: spec.raw, messageId: ctx.replyAnchor };
    return resolveReplyAnchor(anchorSpec, ctx, 'replyAnchor');
  }

  switch (spec.kind) {
    case 'messageCount':
      return resolveMessageCount(spec, ctx);
    case 'duration':
      return resolveInstant(spec, ctx, durationStart(spec.duration, ctx), 'explicit');
    case 'sinceDate':
      return resolveInstant(spec, ctx, dateStart(spec.date, ctx.timeZone), 'explicit');
    case 'namedWindow':
      return resolveInstant(spec, ctx, namedWindowStart(spec.window, ctx), 'explicit');
    case 'replyAnchor':
      return resolveReplyAnchor(spec, ctx, 'explicit');
    case 'default':
      return resolveInstant(spec, ctx, defaultStart(ctx), 'default');
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

function limitFor(ctx: RangeResolutionContext): number {
  return Math.min(ctx.maxMessages, MAX_RANGE_MESSAGES_HARD_CAP);
}

function withHorizon(
  ts: Temporal.Instant,
  ctx: RangeResolutionContext,
): { readonly ts: Temporal.Instant; readonly clamped: boolean } {
  if (ctx.storedHorizon !== null && Temporal.Instant.compare(ts, ctx.storedHorizon) < 0) {
    return { ts: ctx.storedHorizon, clamped: true };
  }
  return { ts, clamped: false };
}

function resolveInstant(
  spec: RangeSpec,
  ctx: RangeResolutionContext,
  ts: Temporal.Instant,
  basis: RangeBasis,
): ResolvedRange {
  const { ts: start, clamped } = withHorizon(ts, ctx);
  return {
    scope: ctx.scope,
    start: { kind: 'instant', ts: start },
    end: ctx.now,
    limit: limitFor(ctx),
    spec,
    basis,
    clampedToHorizon: clamped,
    timeZone: ctx.timeZone,
  };
}

function resolveMessageCount(spec: MessageCountSpec, ctx: RangeResolutionContext): ResolvedRange {
  const count = Math.min(spec.count, ctx.maxMessages, MAX_RANGE_MESSAGES_HARD_CAP);
  return {
    scope: ctx.scope,
    start: { kind: 'lastN', count },
    end: ctx.now,
    limit: count,
    spec,
    basis: 'explicit',
    clampedToHorizon: false,
    timeZone: ctx.timeZone,
  };
}

function resolveReplyAnchor(
  spec: ReplyAnchorSpec,
  ctx: RangeResolutionContext,
  basis: RangeBasis,
): ResolvedRange {
  return {
    scope: ctx.scope,
    start: { kind: 'message', messageId: spec.messageId, inclusive: true },
    end: ctx.now,
    limit: limitFor(ctx),
    spec,
    basis,
    clampedToHorizon: false,
    timeZone: ctx.timeZone,
  };
}

/* -------------------------------------------------------------------------- */
/* Start-instant computation (DST-correct: calendar arithmetic in the zone)   */
/* -------------------------------------------------------------------------- */

function durationLike(duration: RangeDuration): Temporal.DurationLike {
  switch (duration.unit) {
    case 'minutes':
      return { minutes: duration.amount };
    case 'hours':
      return { hours: duration.amount };
    case 'days':
      return { days: duration.amount };
    case 'weeks':
      return { weeks: duration.amount };
  }
}

function durationStart(duration: RangeDuration, ctx: RangeResolutionContext): Temporal.Instant {
  return ctx.now.toZonedDateTimeISO(ctx.timeZone).subtract(durationLike(duration)).toInstant();
}

function dateStart(date: Temporal.PlainDate, timeZone: TimeZoneId): Temporal.Instant {
  return date.toZonedDateTime(timeZone).toInstant();
}

function namedWindowStart(window: NamedWindow, ctx: RangeResolutionContext): Temporal.Instant {
  const today = ctx.now.toZonedDateTimeISO(ctx.timeZone).toPlainDate();
  const startDate = startDateFor(window, today);
  return startDate.toZonedDateTime(ctx.timeZone).toInstant();
}

function startDateFor(window: NamedWindow, today: Temporal.PlainDate): Temporal.PlainDate {
  // ISO week: `dayOfWeek` is 1 (Monday) .. 7 (Sunday).
  switch (window) {
    case 'today':
      return today;
    case 'yesterday':
      return today.subtract({ days: 1 });
    case 'thisWeek':
      return today.subtract({ days: today.dayOfWeek - 1 });
    case 'lastWeek':
      return today.subtract({ days: today.dayOfWeek - 1 + 7 });
    case 'thisMonth':
      return today.with({ day: 1 });
    case 'lastMonth':
      return today.with({ day: 1 }).subtract({ months: 1 });
  }
}

function defaultStart(ctx: RangeResolutionContext): Temporal.Instant {
  return ctx.now
    .toZonedDateTimeISO(ctx.timeZone)
    .subtract({ days: ctx.defaultRangeDays })
    .toInstant();
}
