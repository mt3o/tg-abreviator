/**
 * Per-user cooldown (DESIGN §9): "1 call / 60s, in-memory, replies with
 * remaining seconds."
 *
 * Deliberately in-memory rather than a store: a cooldown is a rate limiter,
 * not a durable record, and losing it on restart is fine — the worst case is
 * one extra call right after a deploy. Keying is per `(chatId, userId)`
 * rather than per user globally, because there is no product reason to make a
 * user's cooldown in one chat block them in another.
 */
import { CooldownError } from '../../domain/errors.js';
import type { Temporal } from '../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../domain/model/ids.js';
import type { Clock } from '../ports/driven/clock.js';

function key(chatId: ChatId, userId: UserId): string {
  return `${String(chatId)}:${String(userId)}`;
}

export class CooldownGuard {
  readonly #clock: Clock;
  readonly #lastCallAt = new Map<string, Temporal.Instant>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Throws `CooldownError` (with the remaining seconds, rounded up so "1
   * second left" never reads as "0 seconds left") when the user is still
   * within `cooldownSeconds` of their last call in this chat. Otherwise
   * records this call as the new "last call" and returns normally.
   *
   * Recording happens on every attempt, including one that the guard itself
   * is about to reject for an unrelated reason later in the pipeline (daily
   * cap, budget) — the cooldown exists to bound *how often the bot is asked
   * to do work at all*, not only how often it succeeds.
   */
  check(chatId: ChatId, userId: UserId, cooldownSeconds: number): void {
    const mapKey = key(chatId, userId);
    const now = this.#clock.now();
    const last = this.#lastCallAt.get(mapKey);
    if (last !== undefined) {
      const elapsedSeconds = now.since(last).total('seconds');
      if (elapsedSeconds < cooldownSeconds) {
        const remaining = Math.ceil(cooldownSeconds - elapsedSeconds);
        throw new CooldownError(Math.max(remaining, 1));
      }
    }
    this.#lastCallAt.set(mapKey, now);
  }

  /** Test/ops escape hatch: forget every recorded cooldown. */
  reset(): void {
    this.#lastCallAt.clear();
  }
}
