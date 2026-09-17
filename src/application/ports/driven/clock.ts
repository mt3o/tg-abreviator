/**
 * `Clock` — `now() -> Temporal.Instant` (DESIGN §3).
 *
 * A port, not an import. TTL expiry, bucket boundaries, dedupe windows and
 * cooldowns all depend on the current time, and all of them must be
 * deterministic under test. Nothing outside an adapter may call `Temporal.Now`;
 * eslint enforces that in `domain` and `application`.
 *
 * `sleep` is here for the same reason: `429 retry_after` is authoritative and
 * the delivery throttle is ~1 edit / 3s (DESIGN §8), and a test that actually
 * waited three seconds per edit would be useless.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { TimeZoneId } from '../../../domain/time/temporal.js';

export interface Clock {
  now(): Temporal.Instant;

  /** The same instant in a chat's zone. DST-correct range arithmetic needs this. */
  nowIn(timeZone: TimeZoneId): Temporal.ZonedDateTime;

  /** Resolves after (at least) `milliseconds`. Fakes resolve immediately. */
  sleep(milliseconds: number): Promise<void>;
}
