/**
 * Registration shape for a range-grammar lexicon (DESIGN §2).
 *
 * "Natural-language time words are parsed deterministically from a PL+EN
 * lexicon... Extensible to more languages." A `RangeLexicon` is the unit a new
 * language contributes: a flat list of phrases, each mapped onto one of the
 * closed `NamedWindow` values already fixed by `src/domain/model/range.ts`.
 * Adding Ukrainian, say, means adding `uk.ts` with its own `RangeLexicon` and
 * registering it in `index.ts` — nothing else in this module changes.
 */
import type { NamedWindow } from '../../model/range.js';

/**
 * One phrase this lexicon recognises as the leading token.
 *
 * `phrase` is matched case-insensitively against the start of the argument
 * string and must be lower-case here (the matcher lower-cases the input, not
 * the phrase table). Multi-word phrases (`w ostatnim tygodniu`) are written
 * with single spaces between words — the matcher does not collapse repeated
 * whitespace.
 */
export interface NamedWindowPhrase {
  readonly phrase: string;
  readonly window: NamedWindow;
}

export interface RangeLexicon {
  /** IETF-ish language tag for documentation; not consulted by the matcher. */
  readonly language: string;
  readonly phrases: readonly NamedWindowPhrase[];
}
