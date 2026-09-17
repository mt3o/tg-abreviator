/**
 * `Clock`, backed by the platform (DESIGN §3, adapter table: `outbound/system`).
 *
 * The port exists so that TTL expiry, bucket boundaries, dedupe windows and
 * cooldowns are deterministic under test; this is the one implementation
 * allowed to read the wall clock, which is why `Temporal.Now` is permitted
 * here and nowhere in `domain` or `application` (eslint enforces that).
 */
import type { Clock } from '../../../application/ports/driven/clock.js';
import { Temporal } from '../../../domain/time/temporal.js';
import type { TimeZoneId } from '../../../domain/time/temporal.js';

export class SystemClock implements Clock {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }

  nowIn(timeZone: TimeZoneId): Temporal.ZonedDateTime {
    return Temporal.Now.zonedDateTimeISO(timeZone);
  }

  /**
   * Real sleep. `429 retry_after` is authoritative (DESIGN §8), so this must
   * actually wait — the fake is what makes tests instant.
   */
  async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, milliseconds));
    });
  }
}
