/**
 * Per-chat concurrency (DESIGN §9): "1 in-flight per chat; also prevents two
 * map-reduce jobs racing on the same chunks."
 *
 * `concurrentPerChat` (`config.guards.concurrentPerChat`) is configurable but
 * intended to stay at 1 (DESIGN §9's own prose says "1 in-flight per chat" as
 * the rule, not as an example) — the guard honours whatever value it is given
 * rather than hardcoding 1, since the config schema already allows tuning it.
 *
 * In-memory: a count of in-flight calls survives exactly as long as the
 * process that is doing the work, which is the correct lifetime for "is a
 * request from this chat currently running".
 */
import { ConcurrentRequestError } from '../../domain/errors.js';
import type { ChatId } from '../../domain/model/ids.js';

export class ConcurrencyGuard {
  readonly #inFlight = new Map<ChatId, number>();

  /** Throws `ConcurrentRequestError` when the chat is already at its limit. */
  acquire(chatId: ChatId, limit: number): void {
    const current = this.#inFlight.get(chatId) ?? 0;
    if (current >= limit) throw new ConcurrentRequestError();
    this.#inFlight.set(chatId, current + 1);
  }

  /** Always pair with a matching `acquire` — callers release in a `finally`. */
  release(chatId: ChatId): void {
    const current = this.#inFlight.get(chatId) ?? 0;
    if (current <= 1) {
      this.#inFlight.delete(chatId);
    } else {
      this.#inFlight.set(chatId, current - 1);
    }
  }

  /** How many calls are currently in flight for a chat. Test/inspection only. */
  inFlightCount(chatId: ChatId): number {
    return this.#inFlight.get(chatId) ?? 0;
  }
}
