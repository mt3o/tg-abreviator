/**
 * Table-driven tests for `parse()` (DESIGN §2; WS3 DoD).
 *
 * "The most heavily tested module in the repo": every row of the grammar
 * table in DESIGN §2 plus the DoD's explicit case list.
 */
import { describe, expect, it } from 'vitest';

import { MissingRangeUnitError, RangeOutOfBoundsError, UnparseableRangeError } from '../errors.js';
import { Temporal } from '../time/temporal.js';
import type { RangeSpec } from '../model/range.js';
import { parse } from './parse.js';

describe('parse() — no arguments', () => {
  it('empty string: default range, no question, not cross-topic', () => {
    const result = parse('');
    expect(result.rangeSpec).toEqual({ kind: 'default', raw: '' });
    expect(result.allTopics).toBe(false);
    expect(result.question).toBeNull();
  });

  it('whitespace-only string behaves like empty', () => {
    const result = parse('   ');
    expect(result.rangeSpec.kind).toBe('default');
    expect(result.question).toBeNull();
  });
});

describe('parse() — message count (bare negative number)', () => {
  it('-50: message count, no question', () => {
    const result = parse('-50');
    expect(result.rangeSpec).toEqual({ kind: 'messageCount', raw: '-50', count: 50 });
    expect(result.question).toBeNull();
  });

  it('-50 with a trailing question', () => {
    const result = parse('-50 co ustalili?');
    expect(result.rangeSpec).toEqual({ kind: 'messageCount', raw: '-50', count: 50 });
    expect(result.question).toBe('co ustalili?');
  });

  it('a count over the hard cap of 500 is out of bounds', () => {
    expect(() => parse('-501')).toThrow(RangeOutOfBoundsError);
  });

  it('exactly the hard cap is allowed', () => {
    const result = parse('-500');
    expect(result.rangeSpec).toEqual({ kind: 'messageCount', raw: '-500', count: 500 });
  });
});

describe('parse() — bare positive number is an error', () => {
  it('50 (no unit): MissingRangeUnitError with a help hint carried on the error', () => {
    expect(() => parse('50')).toThrow(MissingRangeUnitError);
    try {
      parse('50');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingRangeUnitError);
      expect((error as MissingRangeUnitError).token).toBe('50');
    }
  });
});

describe('parse() — durations', () => {
  it('2h: 2 hours, no question', () => {
    const result = parse('2h');
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '2h',
      duration: { unit: 'hours', amount: 2 },
    });
    expect(result.question).toBeNull();
  });

  it('-2h resolves to the same duration as 2h (sign ignored when a unit is present)', () => {
    const plain = parse('2h');
    const signed = parse('-2h');
    expect(signed.rangeSpec.kind).toBe('duration');
    expect(plain.rangeSpec.kind).toBe('duration');
    const plainSpec = plain.rangeSpec as Extract<RangeSpec, { kind: 'duration' }>;
    const signedSpec = signed.rangeSpec as Extract<RangeSpec, { kind: 'duration' }>;
    expect(signedSpec.duration).toEqual(plainSpec.duration);
    // `raw` still carries exactly what the user typed, for the dedupe key.
    expect(signedSpec.raw).toBe('-2h');
  });

  it('30m: 30 minutes', () => {
    const result = parse('30m');
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '30m',
      duration: { unit: 'minutes', amount: 30 },
    });
  });

  it('3d: 3 days', () => {
    const result = parse('3d');
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '3d',
      duration: { unit: 'days', amount: 3 },
    });
  });

  it('1w: 1 week', () => {
    const result = parse('1w');
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '1w',
      duration: { unit: 'weeks', amount: 1 },
    });
  });

  it('2h co ustalili?: duration plus a question, split at the leading token', () => {
    const result = parse('2h co ustalili?');
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '2h',
      duration: { unit: 'hours', amount: 2 },
    });
    expect(result.question).toBe('co ustalili?');
    expect(result.allTopics).toBe(false);
  });
});

describe('parse() — since a date', () => {
  it('2026-09-15: since the start of that day', () => {
    const result = parse('2026-09-15');
    expect(result.rangeSpec.kind).toBe('sinceDate');
    const spec = result.rangeSpec as Extract<RangeSpec, { kind: 'sinceDate' }>;
    expect(spec.raw).toBe('2026-09-15');
    expect(Temporal.PlainDate.compare(spec.date, Temporal.PlainDate.from('2026-09-15'))).toBe(0);
  });

  it('an invalid calendar date shaped like ISO throws, never guesses', () => {
    expect(() => parse('2026-13-45')).toThrow(UnparseableRangeError);
  });
});

describe('parse() — named windows (PL+EN lexicon)', () => {
  it('wczoraj: yesterday', () => {
    const result = parse('wczoraj');
    expect(result.rangeSpec).toEqual({ kind: 'namedWindow', raw: 'wczoraj', window: 'yesterday' });
    expect(result.question).toBeNull();
  });

  it('w ostatnim tygodniu: last week (multi-word PL phrase)', () => {
    const result = parse('w ostatnim tygodniu');
    expect(result.rangeSpec).toEqual({
      kind: 'namedWindow',
      raw: 'w ostatnim tygodniu',
      window: 'lastWeek',
    });
  });

  it('yesterday: yesterday (EN)', () => {
    const result = parse('yesterday');
    expect(result.rangeSpec).toEqual({ kind: 'namedWindow', raw: 'yesterday', window: 'yesterday' });
  });

  it('last week: lastWeek (multi-word EN phrase)', () => {
    const result = parse('last week');
    expect(result.rangeSpec).toEqual({ kind: 'namedWindow', raw: 'last week', window: 'lastWeek' });
  });

  it('a named window followed by a question splits correctly', () => {
    const result = parse('yesterday co się stało?');
    expect(result.rangeSpec).toEqual({ kind: 'namedWindow', raw: 'yesterday', window: 'yesterday' });
    expect(result.question).toBe('co się stało?');
  });

  it('preserves the exact original casing in `raw`', () => {
    const result = parse('Wczoraj');
    expect((result.rangeSpec as { raw: string }).raw).toBe('Wczoraj');
  });
});

describe('parse() — the "all" cross-topic keyword', () => {
  it('all 2h: cross-topic duration, no question', () => {
    const result = parse('all 2h');
    expect(result.allTopics).toBe(true);
    expect(result.rangeSpec).toEqual({
      kind: 'duration',
      raw: '2h',
      duration: { unit: 'hours', amount: 2 },
    });
    expect(result.question).toBeNull();
  });

  it('all alone: cross-topic, default range', () => {
    const result = parse('all');
    expect(result.allTopics).toBe(true);
    expect(result.rangeSpec.kind).toBe('default');
    expect(result.question).toBeNull();
  });

  it('"all" only counts as the keyword at the very start', () => {
    const result = parse('co ustalili all along?');
    expect(result.allTopics).toBe(false);
    expect(result.rangeSpec.kind).toBe('default');
    expect(result.question).toBe('co ustalili all along?');
  });
});

describe('parse() — an ordinary question with no range token', () => {
  it('co ustalili wczoraj?: default range; "wczoraj" stays in the question', () => {
    const result = parse('co ustalili wczoraj?');
    expect(result.rangeSpec).toEqual({ kind: 'default', raw: '' });
    expect(result.question).toBe('co ustalili wczoraj?');
    expect(result.allTopics).toBe(false);
  });
});

describe('parse() — unknown / malformed tokens that look like range attempts', () => {
  it('a digit-led token with an unrecognised unit is unparseable, not a guess', () => {
    expect(() => parse('5x')).toThrow(UnparseableRangeError);
  });

  it('a digit-led token with an unrecognised unit plus a question still throws', () => {
    expect(() => parse('9fortnights co tam?')).toThrow(UnparseableRangeError);
  });

  it('an out-of-range calendar date throws rather than silently truncating', () => {
    expect(() => parse('2026-02-30')).toThrow(UnparseableRangeError);
  });
});

describe('parse() — question text is carried verbatim', () => {
  it('does not alter internal punctuation or spacing of the question', () => {
    const result = parse('2h   co    ustalili???  ');
    expect(result.question).toBe('co    ustalili???');
  });
});
