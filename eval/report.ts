/**
 * Renders an `EvalReport` as readable text for `npm run eval`'s stdout
 * (DESIGN §12, WS13's DoD: "`npm run eval` produces a readable per-fixture
 * diff"). No LLM-as-judge summary score — DESIGN §12 is explicit that a
 * handful of fixtures are meant to be read by a human, so this is a
 * transcript-shaped report, not a single pass/fail number.
 */
import { answerText } from './runner.js';
import type { EvalReport, FixtureReportRow } from './types.js';

const RULE = '─'.repeat(72);

function statusLabel(row: FixtureReportRow): string {
  return row.check.pass ? 'PASS' : 'FAIL';
}

function formatCheckDetails(row: FixtureReportRow): string[] {
  const { check } = row;
  if (check.pass) return [];
  const lines: string[] = [];
  if (check.missing.length > 0) lines.push(`  missing required text: ${check.missing.join(', ')}`);
  if (check.anyMissing) lines.push('  none of the expected alternatives were found');
  if (check.forbiddenFound.length > 0) lines.push(`  contains forbidden text: ${check.forbiddenFound.join(', ')}`);
  return lines;
}

function formatRow(row: FixtureReportRow): string {
  const { fixture } = row.result;
  const lines: string[] = [
    RULE,
    `[${statusLabel(row)}] ${fixture.id} — ${fixture.title}`,
    `  why this fixture exists: ${fixture.rationale}`,
    `  model: ${row.result.model}  prompt_version: ${row.result.promptVersion}`,
    ...formatCheckDetails(row),
    '',
    '  answer:',
    ...answerText(row.result.content)
      .split('\n')
      .map((line) => `    ${line}`),
    '',
    row.previous === null
      ? '  diff vs previous prompt_version: (first run)'
      : `  diff vs prompt_version ${row.previous.promptVersion}:`,
    ...(row.previous === null
      ? []
      : row.diff.split('\n').map((line) => `    ${line}`)),
  ];
  return lines.join('\n');
}

export function formatReport(report: EvalReport): string {
  const passCount = report.rows.filter((row) => row.check.pass).length;
  const header = `eval: ${String(passCount)}/${String(report.rows.length)} fixtures passed`;
  return [header, ...report.rows.map(formatRow), RULE].join('\n');
}
