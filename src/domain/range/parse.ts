/**
 * `parse(argString) -> ParsedArguments` (DESIGN §2, §3).
 *
 * Pure, deterministic, zero I/O. **No LLM anywhere in this module** — the
 * grammar is a hand-written parser precisely so a range token always resolves
 * the same way twice.
 *
 * Grammar (leading-token-only; everything after it is the question, verbatim):
 *
 *   `all`                     — cross-topic flag, consumed first if present
 *   `-50`                     — bare negative integer: message count
 *   `50`                      — bare positive integer: error (needs a unit)
 *   `2h` / `-2h` / `30m` / `3d` / `1w` — signed integer + unit; sign ignored
 *   `2026-09-15`              — ISO date: since the start of that day
 *   `wczoraj` / `yesterday` / `w ostatnim tygodniu` / `last week` / ...
 *                              — PL+EN lexicon (`./lexicon`)
 *   anything else             — not a range attempt: default range, and the
 *                                whole string (including that word) is the
 *                                question. "co ustalili wczoraj?" is the
 *                                canonical case: "co" is not a range token, so
 *                                "wczoraj" stays put, inside the question,
 *                                rather than being guessed at.
 *
 * A token that *looks like* a range attempt (starts with a digit, or matches
 * the ISO date shape) but does not parse throws rather than falling through —
 * DESIGN §2: "Unparseable leading token → error + help, never a guess."
 */
import { MissingRangeUnitError, RangeOutOfBoundsError, UnparseableRangeError } from '../errors.js';
import { Temporal } from '../time/temporal.js';
import {
  MAX_RANGE_MESSAGES_HARD_CAP,
  type DurationUnit,
  type ParsedArguments,
  type RangeSpec,
} from '../model/range.js';
import { NAMED_WINDOW_PHRASES } from './lexicon/index.js';

const DEFAULT_RANGE_SPEC: RangeSpec = Object.freeze({ kind: 'default', raw: '' });

const UNIT_ALIASES: Readonly<Record<string, DurationUnit>> = Object.freeze({
  m: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  minute: 'minutes',
  minutes: 'minutes',
  h: 'hours',
  hr: 'hours',
  hrs: 'hours',
  hour: 'hours',
  hours: 'hours',
  d: 'days',
  day: 'days',
  days: 'days',
  w: 'weeks',
  week: 'weeks',
  weeks: 'weeks',
});

const ALL_KEYWORD_PATTERN = /^all(?=\s|$)/i;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const PURE_INTEGER = /^([+-]?)(\d+)$/;
const NUMBER_WITH_UNIT = /^[+-]?(\d+)([a-zA-Z]+)$/;

/** `parse(argString) -> {rangeSpec, question}` (DESIGN §3). */
export function parse(argString: string): ParsedArguments {
  const trimmed = argString.trim();
  if (trimmed.length === 0) {
    return { rangeSpec: DEFAULT_RANGE_SPEC, allTopics: false, question: null };
  }

  const { allTopics, rest } = consumeAllKeyword(trimmed);
  if (rest.length === 0) {
    return { rangeSpec: DEFAULT_RANGE_SPEC, allTopics, question: null };
  }

  const namedWindow = matchNamedWindow(rest);
  if (namedWindow !== null) {
    return {
      rangeSpec: { kind: 'namedWindow', raw: namedWindow.raw, window: namedWindow.window },
      allTopics,
      question: toQuestion(namedWindow.remainder),
    };
  }

  const leadingWord = firstWord(rest);
  const afterLeadingWord = toQuestion(rest.slice(leadingWord.length));

  if (ISO_DATE_SHAPE.test(leadingWord)) {
    let date: Temporal.PlainDate;
    try {
      date = Temporal.PlainDate.from(leadingWord);
    } catch (cause) {
      throw new UnparseableRangeError(leadingWord, { cause });
    }
    return {
      rangeSpec: { kind: 'sinceDate', raw: leadingWord, date },
      allTopics,
      question: afterLeadingWord,
    };
  }

  const pureInteger = PURE_INTEGER.exec(leadingWord);
  if (pureInteger !== null) {
    const sign = pureInteger[1] ?? '';
    const digits = pureInteger[2] ?? '';
    if (sign === '-') {
      const count = Number(digits);
      if (count > MAX_RANGE_MESSAGES_HARD_CAP) {
        throw new RangeOutOfBoundsError('messageCount', MAX_RANGE_MESSAGES_HARD_CAP);
      }
      return {
        rangeSpec: { kind: 'messageCount', raw: leadingWord, count },
        allTopics,
        question: afterLeadingWord,
      };
    }
    // Bare positive number (DESIGN §2: "Bare 50 is an error with a help hint").
    throw new MissingRangeUnitError(leadingWord);
  }

  const withUnit = NUMBER_WITH_UNIT.exec(leadingWord);
  if (withUnit !== null) {
    const amountStr = withUnit[1] ?? '';
    const unitToken = withUnit[2] ?? '';
    const unit = UNIT_ALIASES[unitToken.toLowerCase()];
    if (unit === undefined) {
      throw new UnparseableRangeError(leadingWord);
    }
    return {
      rangeSpec: {
        kind: 'duration',
        raw: leadingWord,
        // DESIGN §2: "sign is ignored when a unit is present" — amount is
        // always positive on `RangeDuration`.
        duration: { unit, amount: Number(amountStr) },
      },
      allTopics,
      question: afterLeadingWord,
    };
  }

  // Not a range-shaped token at all: it is not "the leading token" in the
  // grammar's sense, just the start of an ordinary question. Default range,
  // whole string is the question, verbatim.
  return { rangeSpec: DEFAULT_RANGE_SPEC, allTopics, question: toQuestion(rest) };
}

function consumeAllKeyword(trimmed: string): { allTopics: boolean; rest: string } {
  const match = ALL_KEYWORD_PATTERN.exec(trimmed);
  if (match === null) return { allTopics: false, rest: trimmed };
  return { allTopics: true, rest: trimmed.slice(match[0].length).trimStart() };
}

function firstWord(text: string): string {
  const idx = text.search(/\s/);
  return idx === -1 ? text : text.slice(0, idx);
}

function toQuestion(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function matchNamedWindow(
  rest: string,
): { readonly window: (typeof NAMED_WINDOW_PHRASES)[number]['window']; readonly raw: string; readonly remainder: string } | null {
  const lower = rest.toLowerCase();
  for (const { phrase, window } of NAMED_WINDOW_PHRASES) {
    if (!lower.startsWith(phrase)) continue;
    const boundary = rest.charAt(phrase.length);
    if (boundary !== '' && !/\s/.test(boundary)) continue;
    return {
      window,
      raw: rest.slice(0, phrase.length),
      remainder: rest.slice(phrase.length),
    };
  }
  return null;
}
