/**
 * Eval harness types (DESIGN §12, WS13).
 *
 * A fixture is a self-contained, synthetic slice of a chat plus a written
 * expectation of what a correct answer must and must not contain — DESIGN
 * §12: "Each adversarial fixture carries a written expectation of what a
 * correct answer must and must not contain." Nothing here touches real chat
 * data; fixtures are hand-written strings, not `StoredMessage` rows, so this
 * module has no dependency on the store or ingestion workstreams.
 */
import type { AnswerContent } from '../src/domain/model/answer.js';

/** One line of a fixture transcript, exactly as it will be rendered. */
export interface FixtureMessage {
  readonly speaker: string;
  /** Display time, `HH:MM`, matching DESIGN §3's `[HH:MM] Name: text` format. */
  readonly time: string;
  readonly text: string;
}

/**
 * A transcript line is either a real message or a gap marker (DESIGN §4: "Gap
 * markers are real rows … any range overlapping a gap gets an explicit line in
 * the output"). `note` is free text describing what is missing, e.g. "no
 * messages logged between 14:10 and 18:45".
 */
export type FixtureLine =
  | { readonly kind: 'message'; readonly message: FixtureMessage }
  | { readonly kind: 'gap'; readonly note: string };

/**
 * What a correct answer must and must not contain, checked as case-insensitive
 * substrings of the answer's combined prose (`summary` + `keyPoints` +
 * `unanswered`, joined — see `answerText` in `runner.ts`).
 *
 * `mustContain` is an AND set: every string must appear. `mustContainAny` is
 * an OR set: at least one must appear, when the set is non-empty — useful when
 * a correct answer can phrase the same fact several reasonable ways (DESIGN
 * §12 explicitly does not want LLM-as-judge scoring, so these are heuristic
 * substring guards, not a grader; a human reads the report either way).
 * `mustNotContain` is a forbidden set: none may appear.
 */
export interface FixtureExpectation {
  readonly mustContain?: readonly string[];
  readonly mustContainAny?: readonly string[];
  readonly mustNotContain?: readonly string[];
}

export type FixtureIntent =
  | { readonly kind: 'summarize' }
  | { readonly kind: 'answer'; readonly question: string };

export interface Fixture {
  /** Stable, filename-safe id. Also the baseline file's key on disk. */
  readonly id: string;
  readonly title: string;
  /** What failure mode this fixture guards against (DESIGN §12). Shown in the report. */
  readonly rationale: string;
  readonly intent: FixtureIntent;
  readonly lines: readonly FixtureLine[];
  readonly expectation: FixtureExpectation;
}

/** One fixture's outcome, for one run. */
export interface FixtureRunResult {
  readonly fixture: Fixture;
  readonly promptVersion: string;
  readonly model: string;
  readonly content: AnswerContent;
}

export interface ExpectationCheck {
  readonly pass: boolean;
  /** `mustContain` entries that were not found. */
  readonly missing: readonly string[];
  /** True when `mustContainAny` was non-empty and none of it matched. */
  readonly anyMissing: boolean;
  /** `mustNotContain` entries that were found anyway. */
  readonly forbiddenFound: readonly string[];
}

/** A fixture's run, its expectation check, and the diff against the last differently-versioned baseline. */
export interface FixtureReportRow {
  readonly result: FixtureRunResult;
  readonly check: ExpectationCheck;
  /** `null` on the very first run of this fixture — nothing to diff against yet. */
  readonly previous: { readonly promptVersion: string; readonly text: string } | null;
  /** Unified-ish diff text between `previous` and this run, or a fixed "(no change)"/"(first run)" marker. */
  readonly diff: string;
}

export interface EvalReport {
  readonly rows: readonly FixtureReportRow[];
  readonly allPassed: boolean;
}
