import { describe, expect, it } from 'vitest';

import { formatReport } from './report.js';
import type { EvalReport, Fixture, FixtureReportRow } from './types.js';

const FIXTURE: Fixture = {
  id: 'demo',
  title: 'Demo fixture',
  rationale: 'because tests need one',
  intent: { kind: 'summarize' },
  lines: [{ kind: 'message', message: { speaker: 'Ola', time: '09:00', text: 'hi' } }],
  expectation: { mustContain: ['hi'] },
};

function row(overrides: Partial<FixtureReportRow> = {}): FixtureReportRow {
  return {
    result: {
      fixture: FIXTURE,
      promptVersion: 'v1',
      model: 'claude-sonnet-5',
      content: { summary: 'summary text', keyPoints: ['point one'], unanswered: ['unanswered one'], tone: 'neutral' },
    },
    check: { pass: true, missing: [], anyMissing: false, forbiddenFound: [] },
    previous: null,
    diff: '(first run)',
    ...overrides,
  };
}

describe('formatReport', () => {
  it('includes a pass/total header', () => {
    const report: EvalReport = { rows: [row()], allPassed: true };
    expect(formatReport(report)).toContain('1/1 fixtures passed');
  });

  it('labels a passing row PASS and a failing row FAIL', () => {
    const passing = row();
    const failing = row({
      check: { pass: false, missing: ['x'], anyMissing: false, forbiddenFound: ['y'] },
    });
    const report: EvalReport = { rows: [passing, failing], allPassed: false };
    const text = formatReport(report);
    expect(text).toContain('[PASS] demo');
    expect(text).toContain('[FAIL] demo');
  });

  it('shows missing and forbidden text for a failing row', () => {
    const failing = row({
      check: { pass: false, missing: ['needed'], anyMissing: false, forbiddenFound: ['banned'] },
    });
    const text = formatReport({ rows: [failing], allPassed: false });
    expect(text).toContain('missing required text: needed');
    expect(text).toContain('contains forbidden text: banned');
  });

  it('includes the fixture rationale and the answer prose', () => {
    const text = formatReport({ rows: [row()], allPassed: true });
    expect(text).toContain('because tests need one');
    expect(text).toContain('summary text');
    expect(text).toContain('point one');
    expect(text).toContain('unanswered one');
  });

  it('shows the diff against a previous prompt_version when there is one', () => {
    const withPrevious = row({
      previous: { promptVersion: 'v0', text: 'old summary' },
      diff: '- old summary\n+ summary text',
    });
    const text = formatReport({ rows: [withPrevious], allPassed: true });
    expect(text).toContain('diff vs prompt_version v0');
    expect(text).toContain('- old summary');
    expect(text).toContain('+ summary text');
  });

  it('says "(first run)" when there is no previous baseline', () => {
    const text = formatReport({ rows: [row()], allPassed: true });
    expect(text).toContain('(first run)');
  });
});
