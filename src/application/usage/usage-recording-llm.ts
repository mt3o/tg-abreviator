/**
 * `Llm` decorator that writes `usage_events` on every call (DESIGN §4: "`Llm.
 * complete()` returns usage on every call, map-phase included, so
 * `usage_events` never has to guess").
 *
 * Wrapping the port — rather than teaching every call site to record its own
 * usage — is what makes this correct for both the single-shot pipeline (WS10)
 * and recursive map-reduce compaction (WS11) without either of them knowing
 * this module exists: whichever one is wired to call `Llm.complete()` at
 * bootstrap, every call it makes is recorded, chunk map calls and the final
 * reduce call alike.
 *
 * The missing ingredient — *which chat this call belongs to* — is not on
 * `LlmRequest` (Phase 0 froze that port without it) and is not this module's
 * to invent; it comes from `currentUsageContext()` (`call-context.ts`), which
 * the guarded pipeline sets for the duration of one user invocation. A call
 * made with no context active (nothing currently running inside
 * `runWithUsageContext`) is not billed to any chat, so it is passed through
 * unrecorded rather than crashing — a bootstrap health-check ping is exactly
 * that case, and DESIGN never asks for those to appear in `usage_events`.
 */
import { currentUsageContext } from './call-context.js';
import { recordUsage, zeroPrices } from './usage-writer.js';
import type { UnitPrices } from '../../domain/model/usage.js';
import type { Clock } from '../ports/driven/clock.js';
import type { IdGenerator } from '../ports/driven/id-generator.js';
import type {
  Llm,
  LlmRequest,
  LlmResponse,
  TokenCountRequest,
} from '../ports/driven/llm.js';
import type { UsageStore } from '../ports/driven/usage-store.js';

export interface UsageRecordingLlmDeps {
  readonly inner: Llm;
  readonly usage: UsageStore;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  /** `models.prices[model]` — the price table entry in force right now. */
  readonly priceFor: (model: string) => UnitPrices;
}

export class UsageRecordingLlm implements Llm {
  readonly #deps: UsageRecordingLlmDeps;

  constructor(deps: UsageRecordingLlmDeps) {
    this.#deps = deps;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const context = currentUsageContext();
    let response: LlmResponse<T>;
    try {
      response = await this.#deps.inner.complete(request);
    } catch (error) {
      if (context !== undefined) {
        await recordUsage(this.#deps.usage, this.#deps.idGenerator, this.#deps.clock, {
          chatId: context.chatId,
          threadId: context.threadId,
          userId: context.userId,
          model: request.model,
          phase: request.phase,
          inputTokens: 0,
          outputTokens: 0,
          unitPrices: this.#deps.priceFor(request.model),
          rangeSpec: context.rangeSpec,
          question: context.question,
          status: 'error',
        });
      }
      throw error;
    }

    if (context !== undefined) {
      await recordUsage(this.#deps.usage, this.#deps.idGenerator, this.#deps.clock, {
        chatId: context.chatId,
        threadId: context.threadId,
        userId: context.userId,
        model: response.model,
        phase: request.phase,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        unitPrices: this.#deps.priceFor(response.model),
        rangeSpec: context.rangeSpec,
        question: context.question,
        status: 'ok',
      });
    }
    return response;
  }

  /** DESIGN §7: "`count_tokens`... billed at zero, recorded for the audit trail." */
  async countTokens(request: TokenCountRequest): Promise<number> {
    const count = await this.#deps.inner.countTokens(request);
    const context = currentUsageContext();
    if (context !== undefined) {
      await recordUsage(this.#deps.usage, this.#deps.idGenerator, this.#deps.clock, {
        chatId: context.chatId,
        threadId: context.threadId,
        userId: context.userId,
        model: request.model,
        phase: 'count_tokens',
        inputTokens: count,
        outputTokens: 0,
        unitPrices: zeroPrices(),
        rangeSpec: context.rangeSpec,
        question: context.question,
        status: 'ok',
      });
    }
    return count;
  }
}
