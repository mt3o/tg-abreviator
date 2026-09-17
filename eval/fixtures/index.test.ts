import { describe, expect, it } from 'vitest';

import { fixtures } from './index.js';

describe('fixtures', () => {
  it('loads the five DESIGN §12 adversarial cases plus the positive control', () => {
    const ids = fixtures.map((fixture) => fixture.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'sarcasm-not-quitting',
        'prompt-injection',
        'retracted-message',
        'gap-marker',
        'nothing-decided',
      ]),
    );
  });

  it('has unique ids', () => {
    const ids = fixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every fixture a non-empty title, rationale and at least one transcript line', () => {
    for (const fixture of fixtures) {
      expect(fixture.title.length).toBeGreaterThan(0);
      expect(fixture.rationale.length).toBeGreaterThan(0);
      expect(fixture.lines.length).toBeGreaterThan(0);
    }
  });

  it('gives every fixture a written expectation (DESIGN §12: "must and must not contain")', () => {
    for (const fixture of fixtures) {
      const { mustContain, mustContainAny, mustNotContain } = fixture.expectation;
      const total = (mustContain?.length ?? 0) + (mustContainAny?.length ?? 0) + (mustNotContain?.length ?? 0);
      expect(total, `fixture "${fixture.id}" has an empty expectation`).toBeGreaterThan(0);
    }
  });

  it('gives every "answer" fixture a non-empty question', () => {
    for (const fixture of fixtures) {
      if (fixture.intent.kind === 'answer') {
        expect(fixture.intent.question.length).toBeGreaterThan(0);
      }
    }
  });
});
