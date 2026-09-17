import { describe, expect, it } from 'vitest';

import { checkExpectations } from './expectations.js';

describe('checkExpectations', () => {
  it('passes when there is nothing to check', () => {
    expect(checkExpectations('anything', {})).toEqual({
      pass: true,
      missing: [],
      anyMissing: false,
      forbiddenFound: [],
    });
  });

  it('is case-insensitive on mustContain and reports what is missing', () => {
    const result = checkExpectations('The deploy is DONE.', { mustContain: ['deploy', 'rollback'] });
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(['rollback']);
  });

  it('requires at least one of mustContainAny, case-insensitively', () => {
    const ok = checkExpectations('there is a GAP in the log', { mustContainAny: ['gap', 'missing'] });
    expect(ok.pass).toBe(true);
    expect(ok.anyMissing).toBe(false);

    const bad = checkExpectations('everything is fine', { mustContainAny: ['gap', 'missing'] });
    expect(bad.pass).toBe(false);
    expect(bad.anyMissing).toBe(true);
  });

  it('fails when a forbidden string is present, case-insensitively', () => {
    const result = checkExpectations('Ola IS QUITTING her job', {
      mustNotContain: ['is quitting'],
    });
    expect(result.pass).toBe(false);
    expect(result.forbiddenFound).toEqual(['is quitting']);
  });

  it('combines all three kinds of check', () => {
    const result = checkExpectations('a b c', {
      mustContain: ['a'],
      mustContainAny: ['b', 'z'],
      mustNotContain: ['c'],
    });
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.anyMissing).toBe(false);
    expect(result.forbiddenFound).toEqual(['c']);
  });
});
