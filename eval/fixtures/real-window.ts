/**
 * Deferred (DESIGN §12): "real-window fixtures with hand-written ground
 * truth, once the ingester has been running long enough to have a corpus."
 * There is no corpus yet, so this is a documented, empty slot — not a stub to
 * fill in later by guesswork.
 *
 * When real fixtures are ready, add entries here in the same `Fixture` shape
 * `eval/fixtures/*.ts` already uses:
 *
 *   - `lines` sourced from an actual logged window (redact anything that
 *     would not itself survive the TTL or `/forgetme` — DESIGN §5, §11 apply
 *     to fixture data exactly as they apply to everything else this bot
 *     touches, even though these lines never reach the DB).
 *   - `expectation` written by a human who has read that window and decided,
 *     in advance, what a correct answer must and must not say — DESIGN §12:
 *     "each adversarial fixture carries a written expectation," and a
 *     real-window fixture is no exception.
 *
 * `eval/fixtures/index.ts` picks up `realWindowFixtures` automatically —
 * exporting an entry here is the only step needed.
 */
import type { Fixture } from '../types.js';

export const realWindowFixtures: readonly Fixture[] = [];
