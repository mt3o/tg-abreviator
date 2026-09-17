/**
 * The eval runner (DESIGN §12, WS13's DoD: "`npm run eval` produces a
 * readable per-fixture diff").
 *
 * For each fixture: build the exact same system prompt and user-turn shape
 * the real pipeline sends (`src/application/prompts`, WS4 — the single
 * source of truth for `PROMPT_VERSION`, so this harness can never silently
 * drift from what production actually sends), call the injected `Llm`, check
 * the fixture's written expectation (`expectations.ts`), and diff the result
 * against the last run recorded under a *different* `prompt_version`
 * (`baseline-store.ts` / `diff-report.ts`).
 *
 * Depends only on the `Llm` port and WS4's prompt-building modules — no
 * `StoredMessage`, no store port, no other workstream's use case.
 */
import { answerContentOutput } from '../src/application/prompts/output-contracts.js';
import {
  buildInstructionsRecap,
  buildSystemPrompt,
  PROMPT_VERSION as DEFAULT_PROMPT_VERSION,
} from '../src/application/prompts/system-prompt.js';
import { buildTranscript } from './transcript.js';
import { checkExpectations } from './expectations.js';
import { formatDiff } from './diff-report.js';
import { previousEntry, readBaselineFile, upsertEntry, writeBaselineFile } from './baseline-store.js';
import type { PromptLanguage } from '../src/application/prompts/system-prompt.js';
import type { AnswerContent } from '../src/domain/model/answer.js';
import type { Llm, LlmUserBlock } from '../src/application/ports/driven/llm.js';
import type { EvalReport, Fixture, FixtureReportRow, FixtureRunResult } from './types.js';

export interface RunAllOptions {
  readonly llm: Llm;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly baselineDir: string;
  /** Defaults to the real `PROMPT_VERSION` (WS4). Overridable so tests can simulate a version bump. */
  readonly promptVersion?: string;
  readonly language?: PromptLanguage;
  /** Defaults to `Date`-free ISO via the caller's clock; only ever informational (see baseline-store.ts). */
  readonly now?: () => string;
}

/** DESIGN §3's corpus prose is what a fixture's expectation is checked against. */
export function answerText(content: AnswerContent): string {
  return [content.summary, ...content.keyPoints, ...content.unanswered].join('\n');
}

export async function runFixture(
  fixture: Fixture,
  options: Pick<RunAllOptions, 'llm' | 'model' | 'maxOutputTokens' | 'promptVersion' | 'language'>,
): Promise<FixtureRunResult> {
  const language = options.language ?? 'en';
  const promptIntent = fixture.intent.kind;
  const phase = 'single';

  const system = buildSystemPrompt({ language, phase, intent: promptIntent });
  const userBlocks: LlmUserBlock[] = [{ kind: 'transcript', text: buildTranscript(fixture.lines) }];
  if (fixture.intent.kind === 'answer') {
    userBlocks.push({ kind: 'question', text: fixture.intent.question });
  }
  userBlocks.push({
    kind: 'instructions_recap',
    text: buildInstructionsRecap({ language, phase, intent: promptIntent }),
  });

  const response = await options.llm.complete<AnswerContent>({
    model: options.model,
    system,
    userBlocks,
    output: answerContentOutput,
    maxOutputTokens: options.maxOutputTokens,
    phase,
  });

  return {
    fixture,
    promptVersion: options.promptVersion ?? DEFAULT_PROMPT_VERSION,
    model: response.model,
    content: response.structured,
  };
}

async function buildRow(result: FixtureRunResult, baselineDir: string, now: () => string): Promise<FixtureReportRow> {
  const check = checkExpectations(answerText(result.content), result.fixture.expectation);

  const existing = await readBaselineFile(baselineDir, result.fixture.id);
  const priorEntry = previousEntry(existing, result.promptVersion);
  const previous =
    priorEntry === null ? null : { promptVersion: priorEntry.promptVersion, text: answerText(priorEntry.content) };
  const diff = previous === null ? '(first run)' : formatDiff(previous.text, answerText(result.content));

  const updated = upsertEntry(existing, {
    promptVersion: result.promptVersion,
    model: result.model,
    content: result.content,
    recordedAt: now(),
  });
  await writeBaselineFile(baselineDir, updated);

  return { result, check, previous, diff };
}

export async function runAll(fixtures: readonly Fixture[], options: RunAllOptions): Promise<EvalReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const rows: FixtureReportRow[] = [];

  // Sequential, deliberately: fixtures run one at a time so a report reads in
  // a stable order and two fixtures never race writing the same baseline dir.
  for (const fixture of fixtures) {
    const result = await runFixture(fixture, options);
    const row = await buildRow(result, options.baselineDir, now);
    rows.push(row);
  }

  return { rows, allPassed: rows.every((row) => row.check.pass) };
}
