/**
 * `SummarizeRange` (DESIGN §3).
 *
 * Expected outcomes — a cooldown, a cap, an empty corpus, a policy refusal —
 * come back as a value, because the dispatcher has to render them as an
 * ordinary reply. Only genuinely unexpected failures throw; those are what the
 * `ErrorReporter` is for.
 */
import type { ErrorCode } from '../../../domain/errors.js';
import type { DeliveredAnswer } from '../../../domain/model/answer.js';
import type { RangeInvocation } from './invocation.js';

export type SummarizeRangeCommand = RangeInvocation;

export type AnswerOutcome =
  | { readonly kind: 'answered'; readonly delivered: DeliveredAnswer }
  /** DESIGN §9: served from the 5-minute dedupe cache, and labelled as such. */
  | { readonly kind: 'cached'; readonly delivered: DeliveredAnswer }
  /**
   * Handled and expected: cooldown, concurrency, daily cap, budget hard stop,
   * empty corpus, unparseable range, policy refusal. `retryAfterSeconds` is set
   * where the user can usefully be told to wait.
   */
  | {
      readonly kind: 'refused';
      readonly code: ErrorCode;
      readonly retryAfterSeconds?: number;
    };

export interface SummarizeRange {
  execute(command: SummarizeRangeCommand): Promise<AnswerOutcome>;
}
