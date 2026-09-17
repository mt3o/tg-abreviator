/**
 * Settable in-memory `Clock` (DESIGN §3).
 *
 * TTL expiry, bucket boundaries, dedupe windows and cooldowns are all
 * time-dependent, so every one of them is only testable if time is a value a
 * test can set.
 *
 * `sleep()` resolves immediately **and advances the clock by the requested
 * amount**. A throttle that waits 3 seconds between edits (DESIGN §8) therefore
 * behaves in a test exactly as it does in production — same number of waits,
 * same resulting timestamps — without the test taking 3 seconds.
 */
import { Temporal } from '../../src/domain/time/temporal.js';
import type { TimeZoneId } from '../../src/domain/time/temporal.js';
import type { Clock } from '../../src/application/ports/driven/clock.js';

/** An arbitrary but fixed reference point: 2026-09-17T12:00:00Z, a Thursday. */
export const DEFAULT_FAKE_NOW = Temporal.Instant.from('2026-09-17T12:00:00Z');

export class FakeClock implements Clock {
  #now: Temporal.Instant;
  /** Every `sleep()` duration, in milliseconds, in call order. */
  readonly sleeps: number[] = [];

  constructor(now: Temporal.Instant = DEFAULT_FAKE_NOW) {
    this.#now = now;
  }

  now(): Temporal.Instant {
    return this.#now;
  }

  nowIn(timeZone: TimeZoneId): Temporal.ZonedDateTime {
    return this.#now.toZonedDateTimeISO(timeZone);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.advanceMillis(milliseconds);
    await Promise.resolve();
  }

  /* ----------------------------- test controls ---------------------------- */

  set(now: Temporal.Instant): void {
    this.#now = now;
  }

  setFrom(isoInstant: string): void {
    this.#now = Temporal.Instant.from(isoInstant);
  }

  advance(duration: Temporal.DurationLike): void {
    this.#now = this.#now.add(duration);
  }

  advanceMillis(milliseconds: number): void {
    this.#now = this.#now.add({ milliseconds });
  }
}
