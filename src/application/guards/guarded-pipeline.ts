/**
 * Composes the individual guards into the one sequence DESIGN §9 describes,
 * without depending on any other workstream's concrete pipeline.
 *
 * WS12's card lists `Depends on: WS1` only — this module is built and tested
 * entirely against Phase 0 ports and fakes plus its own guard primitives
 * (`cooldown-guard.ts`, `concurrency-guard.ts`, `dedupe-cache.ts`,
 * `daily-cap-guard.ts`, `budget-guard.ts`). It deliberately does **not**
 * import `SummarizeRange`/`AnswerQuestion` (WS10), WS4's model router, or any
 * adapter: those are other workstreams' implementations, built and merged in
 * parallel, and reaching into them here would recreate exactly the
 * merge-conflict/contract-drift failure mode `docs/PLAN.md` §0 exists to
 * avoid. Instead, `GuardCheckInput.model` / `.promptVersion` are supplied by
 * the caller — the composition root (Wave 3) resolves those from WS4's
 * router and hands them in, and this module never needs to know how.
 *
 * The sequence, and why this order:
 *
 * 1. **Cooldown** — cheapest check, and it is a per-user abuse guard, so it
 *    applies before anything chat-scoped.
 * 2. **Dedupe lookup** — a hit means no work happens at all: no concurrency
 *    slot taken, no daily-cap or budget check spent on a call that costs
 *    nothing (DESIGN §9: "no provider call, no cost").
 * 3. **Concurrency** — only once it is known real work might follow.
 * 4. **Daily cap**, then **budget** — the budget is the hard stop DESIGN §9
 *    calls "the only control that bounds actual liability", so it runs last:
 *    a chat already over its own daily cap should see *that* refusal, not a
 *    global-budget one, when both would fire.
 *
 * `begin()` returns a decision; `complete()` must be called exactly once
 * afterward when the decision was `'proceed'`, releasing the concurrency slot
 * and — for a genuinely fresh answer — storing it in the dedupe cache for the
 * next identical request.
 */
import {
  BudgetExhaustedError,
  ConcurrentRequestError,
  CooldownError,
  DailyCapError,
} from '../../domain/errors.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { Answer } from '../../domain/model/answer.js';
import type { ChatId, ThreadId, UserId } from '../../domain/model/ids.js';
import type { DedupeKeyInput } from '../../domain/dedupe.js';
import { assertUnderGlobalBudget } from './budget-guard.js';
import { ConcurrencyGuard } from './concurrency-guard.js';
import { CooldownGuard } from './cooldown-guard.js';
import { assertUnderDailyCap } from './daily-cap-guard.js';
import { DedupeCache } from './dedupe-cache.js';
import type { Clock } from '../ports/driven/clock.js';
import type { ErrorReporter } from '../ports/driven/error-reporter.js';
import type { GlobalUsageStore, UsageStore } from '../ports/driven/usage-store.js';

export interface GuardCheckInput {
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly threadId: ThreadId | null;
  readonly rawRangeToken: string;
  readonly question: string | null;
  /** Resolved by the caller (Wave 3, via WS4's router) — never by this module. */
  readonly model: string;
  readonly promptVersion: string;
  readonly cooldownSeconds: number;
  readonly concurrentPerChat: number;
  readonly dailyCallsPerChat: number;
  readonly dedupeTtlSeconds: number;
  readonly globalDailyBudgetUsd: number;
}

export type GuardDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'cached'; readonly answer: Answer; readonly ageMinutes: number }
  | { readonly kind: 'refused'; readonly code: ErrorCode; readonly retryAfterSeconds?: number };

function dedupeKeyInputOf(input: GuardCheckInput): DedupeKeyInput {
  return {
    chatId: input.chatId,
    threadId: input.threadId,
    rawRangeToken: input.rawRangeToken,
    question: input.question,
    model: input.model,
    promptVersion: input.promptVersion,
  };
}

export interface GuardedPipelineDeps {
  readonly clock: Clock;
  readonly usage: UsageStore;
  readonly globalUsage: GlobalUsageStore;
  readonly errorReporter: ErrorReporter;
}

export class GuardedPipeline {
  readonly #deps: GuardedPipelineDeps;
  readonly cooldown: CooldownGuard;
  readonly concurrency = new ConcurrencyGuard();
  readonly dedupe: DedupeCache;

  constructor(deps: GuardedPipelineDeps) {
    this.#deps = deps;
    this.cooldown = new CooldownGuard(deps.clock);
    this.dedupe = new DedupeCache(deps.clock);
  }

  /**
   * Runs the full guard sequence. A `'refused'` decision is final — nothing
   * needs releasing. A `'cached'` decision is also final: no concurrency slot
   * was ever taken for it. Only `'proceed'` requires a matching `complete()`.
   */
  async begin(input: GuardCheckInput): Promise<GuardDecision> {
    try {
      this.cooldown.check(input.chatId, input.userId, input.cooldownSeconds);
    } catch (error) {
      if (error instanceof CooldownError) {
        return { kind: 'refused', code: error.code, retryAfterSeconds: error.retryAfterSeconds };
      }
      throw error;
    }

    const hit = this.dedupe.lookup(dedupeKeyInputOf(input), input.dedupeTtlSeconds);
    if (hit !== null) {
      return { kind: 'cached', answer: hit.answer, ageMinutes: hit.ageMinutes };
    }

    try {
      this.concurrency.acquire(input.chatId, input.concurrentPerChat);
    } catch (error) {
      if (error instanceof ConcurrentRequestError) {
        return { kind: 'refused', code: error.code };
      }
      throw error;
    }

    try {
      const now = this.#deps.clock.now();
      await assertUnderDailyCap(this.#deps.usage, input.chatId, now, input.dailyCallsPerChat);
      await assertUnderGlobalBudget(this.#deps.globalUsage, now, input.globalDailyBudgetUsd);
    } catch (error) {
      this.concurrency.release(input.chatId);
      if (error instanceof BudgetExhaustedError) {
        // DESIGN §11: "budget-cap trips" are worth an operator knowing about,
        // even though this is also a normal, expected refusal for the caller.
        this.#deps.errorReporter.capture(error, { phase: 'guards', errorCode: error.code });
        return { kind: 'refused', code: error.code };
      }
      if (error instanceof DailyCapError) {
        return { kind: 'refused', code: error.code };
      }
      throw error;
    }

    return { kind: 'proceed' };
  }

  /**
   * Always call after a `'proceed'` decision, exactly once. Pass the fresh
   * `Answer` when the call succeeded (it is stored for the next identical
   * request within `dedupeTtlSeconds`); pass `null` when it did not (nothing
   * is cached, but the concurrency slot is still released).
   */
  complete(input: GuardCheckInput, answer: Answer | null): void {
    if (answer !== null) {
      this.dedupe.store(dedupeKeyInputOf(input), answer);
    }
    this.concurrency.release(input.chatId);
  }
}
