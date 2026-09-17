/**
 * Slur substitution (DESIGN §6.6).
 *
 * "Via a configurable PL+EN wordlist applied to rendered output — a regex,
 * not a prompt rule, so it is testable. The model separately emits a `tone`
 * field; a heated exchange still gets a `⚠️` in the header. Baby-talk the
 * words, keep the temperature honest."
 *
 * The wordlist itself lives in config (`safety.slurs`, `Config` port,
 * DESIGN §10) — this module only ever receives it as a plain value, never
 * reads it itself, so the domain stays free of the config-layers dependency
 * (DESIGN §3).
 */

/** Shape-compatible with `ResolvedConfig['safety']['slurs']`, without importing it. */
export type SlurWordlist = Readonly<Record<string, readonly string[]>>;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Baby-talk the words": keep the first character (so the shape of the word
 * is still recognisable — this is de-escalation, not erasure) and replace
 * every following character with `*`. `Array.from` rather than indexing so a
 * multi-code-point first character (e.g. an emoji) is not split in half.
 */
export function maskWord(word: string): string {
  const chars = Array.from(word);
  const first = chars[0];
  if (first === undefined) return word;
  return first + '*'.repeat(chars.length - 1);
}

/**
 * All words across all languages in `wordlist`, longest first so that a
 * multi-word or longer entry is not pre-empted by a shorter one it contains.
 */
function flattenWords(wordlist: SlurWordlist): string[] {
  const words = Object.values(wordlist).flat();
  return [...new Set(words)].filter((word) => word.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Replaces every whole-word, case-insensitive occurrence of a configured
 * slur with its masked form.
 *
 * Word boundaries use `\p{L}`/`\p{N}` lookaround rather than `\b`: `\b` is an
 * ASCII notion and does not treat Polish diacritics (`ą`, `ć`, `ł`, `ó`, `ś`,
 * `ź`, `ż`, …) as word characters, so it would under-match exactly the
 * alphabet this bot's primary lexicon is built on (DESIGN §2, §9).
 *
 * Must run on plain text, *before* `sanitizeToTelegramHtml` — by the time
 * that has run, matched text may be wrapped in allowed tags or have had
 * mention markers spliced into it, and this module has no business parsing
 * HTML to find its way back to the word boundaries.
 */
export function substituteSlurs(text: string, wordlist: SlurWordlist): string {
  const words = flattenWords(wordlist);
  if (words.length === 0) return text;

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return text.replace(pattern, (matched) => maskWord(matched));
}
