/**
 * DESIGN §6.6: slur substitution is a regex over rendered output, testable
 * independently of any prompt.
 */
import { describe, expect, it } from 'vitest';

import { maskWord, substituteSlurs } from './slurs.js';
import type { SlurWordlist } from './slurs.js';

const WORDLIST: SlurWordlist = {
  pl: ['kurwa', 'chuj'],
  en: ['damn'],
};

describe('maskWord', () => {
  it('keeps the first character and masks the rest', () => {
    expect(maskWord('kurwa')).toBe('k****');
  });

  it('handles a single-character word', () => {
    expect(maskWord('x')).toBe('x');
  });

  it('does not split a surrogate-pair first character', () => {
    // '😀' is one Unicode code point but two UTF-16 code units; naive
    // `word[0]` string indexing would slice it in half. `Array.from` does not.
    expect(maskWord('😀abc')).toBe('😀***');
  });
});

describe('substituteSlurs', () => {
  it('replaces a whole-word match, case-insensitively', () => {
    expect(substituteSlurs('to jest KURWA mocne', WORDLIST)).toBe('to jest K**** mocne');
  });

  it('does not touch a word that merely contains a listed word as a substring', () => {
    expect(substituteSlurs('kurwaczek to nie to samo', WORDLIST)).toBe('kurwaczek to nie to samo');
  });

  it('matches across languages in one pass', () => {
    expect(substituteSlurs('well, damn, and chuj too', WORDLIST)).toBe('well, d***, and c*** too');
  });

  it('respects Polish-diacritic word boundaries, not just ASCII \\b', () => {
    // "kurwa" preceded by a diacritic letter with no space is still a
    // distinct word boundary under \p{L}, same as it would be for a plain
    // ASCII letter — the point is that the check does not silently fail to
    // compile or behave differently around ą/ć/ł/ó/ś/ź/ż.
    expect(substituteSlurs('ćwierkają kurwa właśnie', WORDLIST)).toBe('ćwierkają k**** właśnie');
  });

  it('is a no-op with an empty wordlist', () => {
    expect(substituteSlurs('kurwa mać', { pl: [], en: [] })).toBe('kurwa mać');
  });

  it('handles multiple occurrences of the same word', () => {
    expect(substituteSlurs('kurwa kurwa kurwa', WORDLIST)).toBe('k**** k**** k****');
  });

  it('does not throw or hang on regex-special characters in content', () => {
    expect(() => substituteSlurs('.*+?^${}()|[]\\ kurwa', WORDLIST)).not.toThrow();
  });
});
