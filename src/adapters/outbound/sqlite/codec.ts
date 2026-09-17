/**
 * Shared row <-> domain conversions. Every store adapter uses these so a
 * `Temporal.Instant` is always epoch milliseconds in SQLite (DESIGN §4's
 * "never a string, never seconds") and never converted two different ways in
 * two different files.
 */
import { Temporal } from '../../../domain/time/temporal.js';

export function toEpochMillis(instant: Temporal.Instant): number {
  return instant.epochMilliseconds;
}

export function fromEpochMillis(value: number): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(value);
}

/** SQLite has no boolean type; `user_prefs.dm_delivery` is `0`/`1` (STRICT INTEGER). */
export function toSqliteBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqliteBool(value: number): boolean {
  return value !== 0;
}
