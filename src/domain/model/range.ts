/**
 * Range grammar types (DESIGN §2).
 *
 * `RangeSpec` and `ResolvedRange` are **deliberately distinct types**:
 *
 * - `RangeSpec` is *what the user typed* — `-50`, `2h`, `wczoraj`, a reply
 *   anchor, or nothing at all. Dedupe keys on this (DESIGN §9: "Key on the raw
 *   range token, not the resolved window", because `/tldr 2h` twice three
 *   minutes apart resolves to different windows and would never hit).
 * - `ResolvedRange` is *what it resolved to* — a concrete, queryable window.
 *   Stores only ever see this one.
 *
 * Collapsing them is the mistake this split exists to prevent.
 *
 * WS3 owns the functions (`src/domain/range/**`); this file owns the vocabulary
 * they speak, so that the ports could be frozen before the parser existed.
 */
import type { Temporal } from '../time/temporal.js';
import type { TimeZoneId } from '../time/temporal.js';
import type { MessageId } from './ids.js';
import type { Scope } from './scope.js';

/* -------------------------------------------------------------------------- */
/* What the user typed                                                        */
/* -------------------------------------------------------------------------- */

export type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export interface RangeDuration {
  readonly unit: DurationUnit;
  /** Always positive: DESIGN §2, "sign is ignored when a unit is present". */
  readonly amount: number;
}

/**
 * Time words parsed deterministically from the PL+EN lexicon (DESIGN §2).
 * The list is closed here so that a new lexicon entry maps onto an existing
 * window rather than inventing a new resolution rule.
 */
export type NamedWindow =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth';

export type RangeSpecKind =
  | 'messageCount'
  | 'duration'
  | 'sinceDate'
  | 'namedWindow'
  | 'replyAnchor'
  | 'default';

interface RangeSpecBase {
  /**
   * The leading token exactly as the user typed it (`-50`, `2h`, `wczoraj`),
   * or the empty string when there was none. This is what the dedupe key hashes
   * (DESIGN §9).
   */
  readonly raw: string;
}

/** `-50` — a bare negative number is a message count, no unit needed. */
export interface MessageCountSpec extends RangeSpecBase {
  readonly kind: 'messageCount';
  /** Positive magnitude. Hard-capped at `MAX_RANGE_MESSAGES_HARD_CAP`. */
  readonly count: number;
}

/** `2h`, `-2h`, `30m`, `3d`, `1w` — a number that carries a unit. */
export interface DurationSpec extends RangeSpecBase {
  readonly kind: 'duration';
  readonly duration: RangeDuration;
}

/** `2026-09-15` — from the start of that day in the chat's zone. */
export interface SinceDateSpec extends RangeSpecBase {
  readonly kind: 'sinceDate';
  readonly date: Temporal.PlainDate;
}

/** `wczoraj`, `yesterday`, `w ostatnim tygodniu`, `last week`. */
export interface NamedWindowSpec extends RangeSpecBase {
  readonly kind: 'namedWindow';
  readonly window: NamedWindow;
}

/** `/tldr` sent as a reply: since the replied-to message, inclusive. */
export interface ReplyAnchorSpec extends RangeSpecBase {
  readonly kind: 'replyAnchor';
  readonly messageId: MessageId;
}

/** No range given: last `defaultRangeDays` days, capped by `maxMessages`. */
export interface DefaultRangeSpec extends RangeSpecBase {
  readonly kind: 'default';
}

export type RangeSpec =
  | MessageCountSpec
  | DurationSpec
  | SinceDateSpec
  | NamedWindowSpec
  | ReplyAnchorSpec
  | DefaultRangeSpec;

/** The dedupe key input (DESIGN §9): the raw token, never the resolved window. */
export function rawRangeToken(spec: RangeSpec): string {
  return spec.raw;
}

/* -------------------------------------------------------------------------- */
/* What `parse()` returns                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Output of `parse(argString)` (WS3).
 *
 * DESIGN §2: **only the leading token is parsed as a range**; everything after
 * it is the question, verbatim. `all` is a scope keyword, not a range, which is
 * why it comes back separately — range and intent are orthogonal.
 */
export interface ParsedArguments {
  readonly rangeSpec: RangeSpec;
  /** The `all` keyword was present: ignore thread scoping for this call. */
  readonly allTopics: boolean;
  /** The remainder, verbatim and untrimmed of meaning. `null` when empty. */
  readonly question: string | null;
}

/* -------------------------------------------------------------------------- */
/* What it resolved to                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where a resolved range starts.
 *
 * Three shapes rather than one instant, because `-50` genuinely is not a time
 * window: turning it into one would require reading the store first, and the
 * store is exactly what consumes this.
 */
export type RangeStart =
  /** Everything at or after this instant. */
  | { readonly kind: 'instant'; readonly ts: Temporal.Instant }
  /** Everything at or after this message. `inclusive` covers the anchor itself. */
  | { readonly kind: 'message'; readonly messageId: MessageId; readonly inclusive: boolean }
  /** The last `count` matching messages before `end`, after filtering. */
  | { readonly kind: 'lastN'; readonly count: number };

/** Which input won, for the header (DESIGN §2: "a wrong guess must be visible"). */
export type RangeBasis = 'explicit' | 'replyAnchor' | 'default';

/**
 * A concrete, queryable window. This is the only range type a store ever sees.
 *
 * `end` is always *now* (DESIGN §2), captured from the `Clock` port at
 * resolution time so that a call is reproducible in tests.
 */
export interface ResolvedRange {
  readonly scope: Scope;
  readonly start: RangeStart;
  readonly end: Temporal.Instant;
  /**
   * Hard cap on rows returned, applied after filtering, taking the **newest**
   * rows when it bites. Never above `MAX_RANGE_MESSAGES_HARD_CAP`.
   */
  readonly limit: number;
  /** Provenance: what the user typed. Carried so the header and the dedupe key agree. */
  readonly spec: RangeSpec;
  readonly basis: RangeBasis;
  /**
   * The requested window reached further back than the stored corpus does, so
   * it was clamped. The answer must say so (DESIGN §7, §10).
   */
  readonly clampedToHorizon: boolean;
  /** The chat's IANA zone the window was computed in. DST-correct arithmetic. */
  readonly timeZone: TimeZoneId;
}

/**
 * Everything `resolve(spec, ctx)` needs, and nothing it does not.
 *
 * `now` arrives from the `Clock` port rather than being read inside: bucket
 * boundaries, TTLs and dedupe windows all have to be deterministic under test
 * (DESIGN §3).
 */
export interface RangeResolutionContext {
  readonly now: Temporal.Instant;
  readonly timeZone: TimeZoneId;
  readonly scope: Scope;
  /** The replied-to message, when the command was sent as a reply. */
  readonly replyAnchor: MessageId | null;
  /** DESIGN §2: defaults when no range given — 2 days, capped at 500 messages. */
  readonly defaultRangeDays: number;
  readonly maxMessages: number;
  /** Timestamp of the oldest message still stored, for `clampedToHorizon`. */
  readonly storedHorizon: Temporal.Instant | null;
}

/**
 * DESIGN §2: `-N` is hard-capped at 500. Configuration may lower
 * `limits.maxMessagesPerRange` but never raise it above this.
 */
export const MAX_RANGE_MESSAGES_HARD_CAP = 500;
