/**
 * In-memory `Llm`.
 *
 * Two things it refuses to fake away:
 *
 * - **Usage comes back on every call**, map phase included, because that is the
 *   contract `usage_events` depends on (DESIGN §4). A test that forgets to
 *   script usage still gets a real, non-zero number derived from the request.
 * - **The request is recorded verbatim**, so a test can assert the thing WS4's
 *   card demands: that no user-supplied string ever reaches `system`.
 *
 * Responses are scripted as *raw* values and run through the request's own
 * `OutputContract.parse`, so a malformed scripted response fails exactly where a
 * malformed provider response would.
 */
import { LlmInvalidResponseError } from '../../src/domain/errors.js';
import type {
  Llm,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmUsage,
  TokenCountRequest,
} from '../../src/application/ports/driven/llm.js';

export interface ScriptedResponse {
  /** The raw structured payload, as the provider would return it. */
  readonly raw: unknown;
  readonly usage?: Partial<LlmUsage>;
  readonly stopReason?: LlmStopReason;
  /** Thrown instead of answering, for retry and error-path tests. */
  readonly error?: unknown;
}

/** Rough but deterministic: four characters per token. Never used in production. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class FakeLlm implements Llm {
  /** Every request, in order. */
  readonly requests: LlmRequest<unknown>[] = [];
  readonly tokenCountRequests: TokenCountRequest[] = [];
  readonly #queue: ScriptedResponse[] = [];
  /** Used when the queue is empty. */
  respond: ((request: LlmRequest<unknown>) => unknown) | null = null;

  enqueue(...responses: ScriptedResponse[]): this {
    this.#queue.push(...responses);
    return this;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.requests.push(request as LlmRequest<unknown>);
    const scripted = this.#queue.shift();
    if (scripted?.error !== undefined) throw scripted.error;

    let raw: unknown;
    if (scripted !== undefined) {
      raw = scripted.raw;
    } else if (this.respond !== null) {
      raw = this.respond(request as LlmRequest<unknown>);
    } else {
      throw new Error(
        `FakeLlm has no scripted response for a "${request.phase}" call. ` +
          'Call enqueue({ raw }) or set `respond`.',
      );
    }

    let structured: T;
    try {
      structured = request.output.parse(raw);
    } catch (cause) {
      throw new LlmInvalidResponseError(request.output.name, { cause });
    }

    const inputTokens =
      scripted?.usage?.inputTokens ??
      approximateTokens(request.system) +
        request.userBlocks.reduce((sum, block) => sum + approximateTokens(block.text), 0);

    return await Promise.resolve({
      structured,
      usage: {
        inputTokens,
        outputTokens: scripted?.usage?.outputTokens ?? approximateTokens(JSON.stringify(raw)),
        cacheReadTokens: scripted?.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: scripted?.usage?.cacheWriteTokens ?? 0,
      },
      model: request.model,
      stopReason: scripted?.stopReason ?? 'end_turn',
    });
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    this.tokenCountRequests.push(request);
    const total =
      approximateTokens(request.system) +
      request.userBlocks.reduce((sum, block) => sum + approximateTokens(block.text), 0);
    return await Promise.resolve(total);
  }

  /* ---------------------------- test helpers ----------------------------- */

  /** Every `system` prompt the fake was handed. */
  systemPrompts(): readonly string[] {
    return this.requests.map((request) => request.system);
  }

  /** True when no system prompt contains `needle` — the WS4 injection assertion. */
  noSystemPromptContains(needle: string): boolean {
    return !this.systemPrompts().some((prompt) => prompt.includes(needle));
  }
}
