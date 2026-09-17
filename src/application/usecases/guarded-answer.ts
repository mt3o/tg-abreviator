/**
 * The guard + billing shell around `SummarizeRange` / `AnswerQuestion`
 * (DESIGN §9, §4).
 *
 * WS12 built `GuardedPipeline` (cooldown → dedupe → concurrency → daily cap →
 * global budget), `runWithUsageContext` and `UsageRecordingLlm` as pieces
 * explicitly designed to compose *around* the single-shot pipeline rather than
 * inside it — its card depended on WS1 alone, and reaching into WS10's use case
 * would have recreated the contract drift `docs/PLAN.md` §0 exists to avoid.
 * This module is that composition, and it lives in `application` rather than in
 * the composition root because it is behaviour: "any logic that appears in
 * bootstrap belongs in a use case or the domain" (DESIGN §3, PLAN Wave 3).
 *
 * Both driving ports are decorated identically — range and intent are
 * orthogonal (DESIGN §2) — so the whole thing is one function with two
 * two-line adapters on top.
 *
 * Three things it is careful about:
 *
 * 1. **The dedupe key is built from the raw range token** (`RangeSpec.raw`),
 *    never the resolved window: `/tldr 2h` twice three minutes apart resolves
 *    to two different windows and would never hit (DESIGN §9).
 * 2. **The model and prompt version come from the per-chat config**, resolved
 *    through WS4's router exactly as the inner pipeline will resolve them, so
 *    a chat that switched model with `/tldr model` does not serve it an answer
 *    the other model produced.
 * 3. **`runWithUsageContext` wraps the whole inner invocation**, not one call.
 *    A single user invocation can make several provider calls (`count_tokens`,
 *    map, reduce); every one of them must land in `usage_events` against the
 *    same chat, thread, range and question (DESIGN §4).
 */
import type { Answer } from '../../domain/model/answer.js';
import type { RenderLanguage } from '../../domain/render/language.js';
import { routeModel } from '../llm/router.js';
import type { GuardCheckInput, GuardedPipeline } from '../guards/guarded-pipeline.js';
import type { ChatGateway } from '../ports/driven/chat-gateway.js';
import type { ChatConfigView, Config } from '../ports/driven/config.js';
import type { SettingsStore } from '../ports/driven/settings-store.js';
import type { AnswerOutcome } from '../ports/driving/summarize-range.js';
import type { AnswerQuestion, AnswerQuestionCommand } from '../ports/driving/answer-question.js';
import type { RangeInvocation } from '../ports/driving/invocation.js';
import type { SummarizeRange, SummarizeRangeCommand } from '../ports/driving/summarize-range.js';
import { runWithUsageContext } from '../usage/call-context.js';
import { deliverAnswer } from './summarize-range.js';

export interface GuardedAnswerDeps {
  readonly pipeline: GuardedPipeline;
  readonly config: Config;
  readonly gateway: ChatGateway;
  readonly settings: SettingsStore;
}

/** The cached answer, re-stamped so the header can say `↺ … N min` (DESIGN §9). */
function markCached(answer: Answer, ageMinutes: number): Answer {
  return { content: answer.content, meta: { ...answer.meta, cached: { ageMinutes } } };
}

async function guardCheckInput(
  chatConfig: ChatConfigView,
  command: RangeInvocation,
  question: string | null,
): Promise<GuardCheckInput> {
  const guards = chatConfig.get('guards');
  const resolvedModel = routeModel(chatConfig.get('models'), {
    phase: 'single',
    chatId: command.invocation.chatId,
  });
  return await Promise.resolve({
    chatId: command.invocation.chatId,
    userId: command.invocation.invoker.userId,
    threadId: command.invocation.threadId,
    rawRangeToken: command.parsed.rangeSpec.raw,
    question,
    model: resolvedModel.entry.model,
    promptVersion: chatConfig.get('prompts').version,
    cooldownSeconds: guards.cooldownSeconds,
    concurrentPerChat: guards.concurrentPerChat,
    dailyCallsPerChat: guards.dailyCallsPerChat,
    dedupeTtlSeconds: guards.dedupeTtlSeconds,
    globalDailyBudgetUsd: guards.globalDailyBudgetUsd,
  });
}

/**
 * Runs `execute` behind the full guard sequence, with the usage context set
 * for its whole duration. `execute` is the undecorated use case; everything
 * else here is DESIGN §9 and §4.
 */
export async function runGuarded(
  deps: GuardedAnswerDeps,
  command: RangeInvocation,
  question: string | null,
  execute: () => Promise<AnswerOutcome>,
): Promise<AnswerOutcome> {
  const { invocation } = command;
  const chatId = invocation.chatId;
  const chatConfig = await deps.config.forChat(chatId);
  const input = await guardCheckInput(chatConfig, command, question);

  const decision = await deps.pipeline.begin(input);

  if (decision.kind === 'refused') {
    return decision.retryAfterSeconds === undefined
      ? { kind: 'refused', code: decision.code }
      : { kind: 'refused', code: decision.code, retryAfterSeconds: decision.retryAfterSeconds };
  }

  if (decision.kind === 'cached') {
    // No concurrency slot was ever taken for a cache hit, so there is nothing
    // to release: `complete()` is for `'proceed'` only.
    const answer = markCached(decision.answer, decision.ageMinutes);
    const language: RenderLanguage = chatConfig.get('bot').language;
    const delivered = await deliverAnswer(
      { gateway: deps.gateway, settings: deps.settings },
      chatId,
      invocation,
      answer,
      chatConfig,
      language,
      answer.meta.messageCount,
    );
    return { kind: 'answered', delivered };
  }

  let outcome: AnswerOutcome;
  try {
    outcome = await runWithUsageContext(
      {
        chatId,
        threadId: invocation.threadId,
        userId: invocation.invoker.userId,
        rangeSpec: input.rawRangeToken,
        question,
      },
      execute,
    );
  } catch (error) {
    // The slot is released either way; nothing is cached for a call that
    // failed, so the next identical request really does retry.
    deps.pipeline.complete(input, null);
    throw error;
  }

  deps.pipeline.complete(input, outcome.kind === 'answered' ? outcome.delivered.answer : null);
  return outcome;
}

export class GuardedSummarizeRange implements SummarizeRange {
  readonly #deps: GuardedAnswerDeps;
  readonly #inner: SummarizeRange;

  constructor(deps: GuardedAnswerDeps, inner: SummarizeRange) {
    this.#deps = deps;
    this.#inner = inner;
  }

  async execute(command: SummarizeRangeCommand): Promise<AnswerOutcome> {
    return await runGuarded(this.#deps, command, null, async () => await this.#inner.execute(command));
  }
}

export class GuardedAnswerQuestion implements AnswerQuestion {
  readonly #deps: GuardedAnswerDeps;
  readonly #inner: AnswerQuestion;

  constructor(deps: GuardedAnswerDeps, inner: AnswerQuestion) {
    this.#deps = deps;
    this.#inner = inner;
  }

  async execute(command: AnswerQuestionCommand): Promise<AnswerOutcome> {
    return await runGuarded(
      this.#deps,
      command,
      command.question,
      async () => await this.#inner.execute(command),
    );
  }
}
