/**
 * Pseudonymous labels (DESIGN §11).
 *
 * GlitchTip sees `chat=quiet-harbor user=kind-otter` and never a raw id, never
 * a display name and never an HMAC. The branding is not decoration: the
 * `ErrorContext` tag set accepts `PseudonymLabel` and nothing else, so
 * `capture(err, { user: userId })` does not compile. The type system is the
 * first line of the §11 scrubbing rule; `beforeSend` is the second.
 *
 * The label is resolvable only through the local `pseudonyms` table, which is
 * why `/forgetme` deleting that row makes an already-emitted label permanently
 * unresolvable.
 */
import { InvalidValueError } from '../errors.js';

declare const pseudonymBrand: unique symbol;

export type PseudonymLabel = string & { readonly [pseudonymBrand]: 'PseudonymLabel' };

/** `kind-otter`, `quiet-harbor`: two lowercase words from the wordlist, hyphenated. */
const LABEL_PATTERN = /^[a-z]+-[a-z]+$/;

export function asPseudonymLabel(value: string): PseudonymLabel {
  if (!LABEL_PATTERN.test(value)) {
    throw new InvalidValueError(`pseudonym label must match ${String(LABEL_PATTERN)}`);
  }
  return value as PseudonymLabel;
}

/**
 * The chat itself gets a label too (DESIGN §11). The `pseudonyms` table is keyed
 * `(chat_id, user_id)`, so the chat's own row uses this sentinel — Telegram
 * never issues user id 0.
 */
export const CHAT_PSEUDONYM_USER_ID = 0;

/* -------------------------------------------------------------------------- */
/* The word list                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One list, shared by every implementation, so that a label looks the same
 * whoever allocated it and an operator reading GlitchTip recognises the shape.
 *
 * Deliberately bland: a pseudonym that reads as a joke about a user is not a
 * pseudonym any more. `ADJECTIVES.length * NOUNS.length` is the per-chat label
 * space; callers retry on collision, which is why allocation needs a store.
 */
export const PSEUDONYM_ADJECTIVES: readonly string[] = Object.freeze([
  'amber', 'brisk', 'calm', 'clear', 'cool', 'dry', 'early', 'fair',
  'gentle', 'glad', 'grey', 'kind', 'late', 'lively', 'lone', 'mellow',
  'mild', 'neat', 'plain', 'polite', 'proud', 'quick', 'quiet', 'rapid',
  'ready', 'rough', 'round', 'sharp', 'silent', 'slow', 'small', 'smooth',
  'soft', 'solid', 'spare', 'steady', 'stern', 'still', 'sunny', 'swift',
  'tidy', 'trim', 'warm', 'wide', 'wise', 'young', 'zesty', 'bright',
]);

export const PSEUDONYM_NOUNS: readonly string[] = Object.freeze([
  'otter', 'heron', 'harbor', 'meadow', 'falcon', 'badger', 'cedar', 'ember',
  'finch', 'fjord', 'glade', 'grove', 'hollow', 'island', 'kestrel', 'lantern',
  'marten', 'mallard', 'orchard', 'osprey', 'pebble', 'pelican', 'quarry', 'raven',
  'ridge', 'river', 'salmon', 'sparrow', 'summit', 'thicket', 'thrush', 'tundra',
  'valley', 'walrus', 'willow', 'yarrow', 'anchor', 'beacon', 'canyon', 'delta',
]);

/** The label space available per chat before collisions become unavoidable. */
export const PSEUDONYM_LABEL_SPACE = PSEUDONYM_ADJECTIVES.length * PSEUDONYM_NOUNS.length;

/** Pure: the caller supplies the indices (from `IdGenerator`, never `Math.random`). */
export function composeLabel(adjectiveIndex: number, nounIndex: number): PseudonymLabel {
  const adjective = PSEUDONYM_ADJECTIVES[adjectiveIndex % PSEUDONYM_ADJECTIVES.length];
  const noun = PSEUDONYM_NOUNS[nounIndex % PSEUDONYM_NOUNS.length];
  if (adjective === undefined || noun === undefined) {
    throw new InvalidValueError('pseudonym word list index out of range');
  }
  return asPseudonymLabel(`${adjective}-${noun}`);
}
