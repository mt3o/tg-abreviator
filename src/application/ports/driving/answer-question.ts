/**
 * `AnswerQuestion` (DESIGN §3).
 *
 * Identical plumbing to `SummarizeRange` — range and intent are orthogonal
 * (DESIGN §2) — with one addition: the question itself, verbatim, exactly as
 * the user typed it after the leading range token.
 *
 * That string is **untrusted**. It travels to the provider inside a delimited
 * `<question>` block in the `user` turn and never touches the system prompt.
 */
import type { RangeInvocation } from './invocation.js';
import type { AnswerOutcome } from './summarize-range.js';

export interface AnswerQuestionCommand extends RangeInvocation {
  /** Verbatim. Not normalized — normalization happens only for the dedupe key. */
  readonly question: string;
}

export interface AnswerQuestion {
  execute(command: AnswerQuestionCommand): Promise<AnswerOutcome>;
}

export type { AnswerOutcome };
