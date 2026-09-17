import { describe, expect, it } from 'vitest';

import { dedupeKey, hashQuestion, normalizeQuestion } from './dedupe.js';
import { asChatId, asThreadId } from './model/ids.js';
import type { DedupeKeyInput } from './dedupe.js';

const CHAT_ID = asChatId(-1_000_000_000_001);
const THREAD_ID = asThreadId(42);

function baseInput(overrides: Partial<DedupeKeyInput> = {}): DedupeKeyInput {
  return {
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    rawRangeToken: '2h',
    question: 'co ustalili?',
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    ...overrides,
  };
}

describe('normalizeQuestion', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeQuestion('  co ustalili?  ')).toBe('co ustalili');
  });

  it('collapses internal whitespace runs, including newlines and tabs', () => {
    expect(normalizeQuestion('co   ustalili\n\tw sprawie budżetu?')).toBe(
      'co ustalili w sprawie budżetu',
    );
  });

  it('lowercases using Polish casing rules', () => {
    expect(normalizeQuestion('CO USTALILI ŁUKASZ I MARIUSZ?')).toBe(
      'co ustalili łukasz i mariusz',
    );
  });

  it('strips a single trailing punctuation mark from ?!.', () => {
    expect(normalizeQuestion('co ustalili?')).toBe('co ustalili');
    expect(normalizeQuestion('co ustalili!')).toBe('co ustalili');
    expect(normalizeQuestion('co ustalili.')).toBe('co ustalili');
  });

  it('strips a run of trailing punctuation, not just one character', () => {
    expect(normalizeQuestion('co ustalili?!')).toBe('co ustalili');
    expect(normalizeQuestion('naprawdę?!?!')).toBe('naprawdę');
  });

  it('does not touch punctuation that is not trailing', () => {
    expect(normalizeQuestion('co? ustalili')).toBe('co? ustalili');
  });

  it('normalizes decomposed and composed Polish diacritics to the same string', () => {
    // "ó" as one precomposed codepoint (U+00F3) vs "o" + combining acute (U+006F U+0301).
    const composed = 'co ustalili w tym tygodniu?';
    const composedWithOgonek = 'zrobili to wczoraj w mieście żółtej łódce?';
    const decomposedWithOgonek =
      'zrobili to wczoraj w mieście żółtej łódce?'.normalize('NFD');
    expect(normalizeQuestion(decomposedWithOgonek)).toBe(normalizeQuestion(composedWithOgonek));
    expect(normalizeQuestion(composed).normalize('NFC')).toBe(normalizeQuestion(composed));
  });

  it('is idempotent', () => {
    const once = normalizeQuestion('  Co Ustalili???  ');
    expect(normalizeQuestion(once)).toBe(once);
  });
});

describe('dedupeKey', () => {
  it('is deterministic for identical input', () => {
    expect(dedupeKey(baseInput())).toBe(dedupeKey(baseInput()));
  });

  it('produces a 64-character lowercase hex sha256 digest', () => {
    expect(dedupeKey(baseInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for a byte-identical resend, which is exactly the case it exists for', () => {
    const first = dedupeKey(baseInput({ question: 'co ustalili?' }));
    const resend = dedupeKey(baseInput({ question: 'co ustalili?' }));
    expect(first).toBe(resend);
  });

  it('treats composed and decomposed diacritics in the question as the same key', () => {
    const composed = dedupeKey(baseInput({ question: 'żółta łódka?' }));
    const decomposed = dedupeKey(baseInput({ question: 'żółta łódka?'.normalize('NFD') }));
    expect(composed).toBe(decomposed);
  });

  it('changes when the chat differs', () => {
    const other = dedupeKey(baseInput({ chatId: asChatId(-999) }));
    expect(other).not.toBe(dedupeKey(baseInput()));
  });

  it('changes when the thread differs, including thread vs. no thread', () => {
    const noThread = dedupeKey(baseInput({ threadId: null }));
    const otherThread = dedupeKey(baseInput({ threadId: asThreadId(7) }));
    expect(noThread).not.toBe(dedupeKey(baseInput()));
    expect(otherThread).not.toBe(dedupeKey(baseInput()));
    expect(noThread).not.toBe(otherThread);
  });

  it('changes when a rephrase changes the normalized question', () => {
    const rephrased = dedupeKey(baseInput({ question: 'co postanowili?' }));
    expect(rephrased).not.toBe(dedupeKey(baseInput()));
  });

  it('changes when the model differs', () => {
    const other = dedupeKey(baseInput({ model: 'claude-haiku-4-5' }));
    expect(other).not.toBe(dedupeKey(baseInput()));
  });

  it('changes when the prompt version differs, so a fixed prompt never serves stale cache', () => {
    const other = dedupeKey(baseInput({ promptVersion: 'v2' }));
    expect(other).not.toBe(dedupeKey(baseInput()));
  });

  it('does not collide across the field separator: adjacent-field concatenation stays distinct', () => {
    // "ab" + "" + "c" must not equal "a" + "" + "bc" once separators are involved —
    // guards against a naive plain-concatenation implementation.
    const a = dedupeKey(baseInput({ rawRangeToken: 'ab', question: 'c' }));
    const b = dedupeKey(baseInput({ rawRangeToken: 'a', question: 'bc' }));
    expect(a).not.toBe(b);
  });

  it('keys on the raw range token, not any resolved window: two different raw tokens that could', () => {
    // resolve to overlapping windows still produce different keys, and the same
    // raw token produces the same key regardless of when it is evaluated (the
    // resolved window is not even part of this function's input at all).
    const twoHours = dedupeKey(baseInput({ rawRangeToken: '2h' }));
    const oneWeek = dedupeKey(baseInput({ rawRangeToken: '1w' }));
    expect(twoHours).not.toBe(oneWeek);

    const sameTokenAgain = dedupeKey(baseInput({ rawRangeToken: '2h' }));
    expect(sameTokenAgain).toBe(twoHours);
  });

  it('treats a null question (summarize) and an empty-string question as the same key', () => {
    // Defensive: both collapse to the empty normalized question. `null` is what
    // a real summarize call passes; this documents the collapse rather than
    // asserting it is desirable to ever pass '' deliberately.
    const withNull = dedupeKey(baseInput({ question: null }));
    const withEmpty = dedupeKey(baseInput({ question: '' }));
    expect(withNull).toBe(withEmpty);
  });
});

describe('hashQuestion', () => {
  it('returns null for a null question (a summarize call)', () => {
    expect(hashQuestion(null)).toBeNull();
  });

  it('returns a 64-character lowercase hex sha256 digest for a question', () => {
    expect(hashQuestion('co ustalili?')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across composed and decomposed diacritics', () => {
    expect(hashQuestion('żółta łódka?')).toBe(hashQuestion('żółta łódka?'.normalize('NFD')));
  });

  it('never contains the question text itself', () => {
    const hash = hashQuestion('co ustalili w sprawie budżetu?');
    expect(hash).not.toContain('budżetu');
    expect(hash).not.toContain('ustalili');
  });

  it('differs from the dedupeKey for the same question, since it carries no chat/model/prompt salt', () => {
    const question = 'co ustalili?';
    const qHash = hashQuestion(question);
    const dHash = dedupeKey(baseInput({ question }));
    expect(qHash).not.toBe(dHash);
  });
});
