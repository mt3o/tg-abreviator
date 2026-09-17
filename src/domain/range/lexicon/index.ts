/**
 * The registered lexicons (DESIGN §2: "Extensible to more languages").
 *
 * A third language is additive: write its `RangeLexicon` in its own file and
 * add it to `REGISTERED_LEXICONS`. Nothing in `parse.ts` changes.
 *
 * `NAMED_WINDOW_PHRASES` is every phrase from every registered lexicon,
 * flattened and sorted longest-phrase-first so a multi-word phrase is matched
 * before a shorter one that happens to be its prefix (none collide today, but
 * a fourth lexicon might introduce one, and this ordering rule is what keeps
 * that additive rather than a bug hunt).
 */
import type { NamedWindowPhrase, RangeLexicon } from './types.js';
import { EN_LEXICON } from './en.js';
import { PL_LEXICON } from './pl.js';

export const REGISTERED_LEXICONS: readonly RangeLexicon[] = Object.freeze([PL_LEXICON, EN_LEXICON]);

export const NAMED_WINDOW_PHRASES: readonly NamedWindowPhrase[] = Object.freeze(
  REGISTERED_LEXICONS.flatMap((lexicon) => lexicon.phrases).sort(
    (a, b) => b.phrase.length - a.phrase.length,
  ),
);

export type { NamedWindowPhrase, RangeLexicon } from './types.js';
