/**
 * The dedupe cache (DESIGN §9): "identical request within ~5 min returns the
 * previous answer, marked `↺ odpowiedź sprzed N min`."
 *
 * Keyed by `dedupeKey` (`src/domain/dedupe.ts`). No store port exists for
 * this in Phase 0 — deliberately: a 5-minute TTL cache is exactly the kind of
 * state that should not survive a restart (a stale "just asked this" entry
 * outliving the process would be a bug, not a feature), so it is in-memory
 * here, next to `CooldownGuard` and `ConcurrencyGuard`.
 *
 * `DeliveredAnswer` is stored *as delivered*, not the pre-render `Answer` —
 * the header, splitting and rendering already ran once, and would run again
 * with the identical content the second time regardless, so there is nothing
 * to gain from re-deriving them; what changes on a hit is only the "served
 * from cache" disclosure, which the guarded pipeline layers on separately
 * (`AnswerMeta.cached`) before re-rendering and re-delivering (DESIGN §9: a
 * cache hit still produces a reply — the user asked again and expects one —
 * it is simply not recomputed).
 */
import type { Temporal } from '../../domain/time/temporal.js';
import type { DedupeKeyInput } from '../../domain/dedupe.js';
import { dedupeKey } from '../../domain/dedupe.js';
import type { Answer } from '../../domain/model/answer.js';
import type { Clock } from '../ports/driven/clock.js';

interface CacheEntry {
  readonly answer: Answer;
  readonly at: Temporal.Instant;
}

export interface DedupeHit {
  readonly answer: Answer;
  /** Floored minutes since the cached call, for the `↺ odpowiedź sprzed N min` label. */
  readonly ageMinutes: number;
}

export class DedupeCache {
  readonly #clock: Clock;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * `null` on a miss, including an entry that exists but has aged out of
   * `ttlSeconds` — an expired entry is evicted on the read that finds it
   * expired, rather than swept separately, since nothing here needs to scan
   * the whole map proactively.
   */
  lookup(input: DedupeKeyInput, ttlSeconds: number): DedupeHit | null {
    const mapKey = dedupeKey(input);
    const entry = this.#entries.get(mapKey);
    if (entry === undefined) return null;

    const now = this.#clock.now();
    const ageSeconds = now.since(entry.at).total('seconds');
    if (ageSeconds > ttlSeconds) {
      this.#entries.delete(mapKey);
      return null;
    }
    return { answer: entry.answer, ageMinutes: Math.floor(ageSeconds / 60) };
  }

  /** Records a fresh answer under its dedupe key, timestamped now. */
  store(input: DedupeKeyInput, answer: Answer): void {
    this.#entries.set(dedupeKey(input), { answer, at: this.#clock.now() });
  }

  /** Test/ops escape hatch: forget every cached answer. */
  reset(): void {
    this.#entries.clear();
  }
}
