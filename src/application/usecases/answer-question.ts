/**
 * `AnswerQuestion` (DESIGN §2, §3). Identical plumbing to `SummarizeRange` —
 * range and intent are orthogonal (DESIGN §2) — so both driving ports share
 * `runAnswerPipeline` (`summarize-range.ts`). The only difference is the
 * `Intent`: this one carries the user's question, which travels to the model
 * only as a delimited `<question>` block in the `user` turn (WS4's hard
 * requirement) — it never reaches `system`, and this module never touches it
 * except to hand it, verbatim and untouched, to `answerIntent()`.
 */
import { answerIntent } from '../../domain/model/intent.js';
import { runAnswerPipeline } from './summarize-range.js';
import type { AnswerPipelineDeps } from './summarize-range.js';
import type {
  AnswerOutcome,
  AnswerQuestion,
  AnswerQuestionCommand,
} from '../ports/driving/answer-question.js';

export class AnswerQuestionUseCase implements AnswerQuestion {
  readonly #deps: AnswerPipelineDeps;

  constructor(deps: AnswerPipelineDeps) {
    this.#deps = deps;
  }

  async execute(command: AnswerQuestionCommand): Promise<AnswerOutcome> {
    return await runAnswerPipeline(this.#deps, command, answerIntent(command.question));
  }
}
