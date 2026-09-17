/**
 * `Llm` — `complete(request) -> { structured, usage }` (DESIGN §3, §7).
 *
 * Three contract decisions worth stating out loud:
 *
 * 1. **`usage` comes back on every call**, map phase included, so
 *    `usage_events` never has to guess what a call cost (DESIGN §4).
 * 2. **Instructions live only in `system`.** The transcript and the question go
 *    in `user` blocks, declared as untrusted data. The type makes the two
 *    physically separate fields so that concatenating them requires effort
 *    (DESIGN, WS4: "never concatenate either into the system prompt").
 * 3. **Structured output only** (DESIGN §6.7): the caller supplies an
 *    `OutputContract`, and a response that does not satisfy it is an error, not
 *    a string to salvage. There is no free-text channel.
 *
 * No `@anthropic-ai/sdk` type appears here. `JsonSchemaObject` is a plain
 * object shape, and `parse` is a plain function — WS4 builds both from Zod
 * inside the adapter.
 */
import type { UsagePhase } from '../../../domain/model/usage.js';

/** A JSON Schema document, as a plain object. Deliberately not a library type. */
export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/**
 * The declared shape of a response, plus the parser that proves a response has
 * it. Validation failure must throw `LlmInvalidResponseError`.
 */
export interface OutputContract<T> {
  /** Stable name, used for the provider's tool/format name and in errors. */
  readonly name: string;
  readonly jsonSchema: JsonSchemaObject;
  readonly parse: (raw: unknown) => T;
}

/**
 * A block of the `user` turn. `kind` becomes the delimiter (`<transcript>`,
 * `<question>`) and marks the content as untrusted data in the prompt.
 */
export interface LlmUserBlock {
  readonly kind: 'transcript' | 'question' | 'chunk_summaries' | 'instructions_recap';
  readonly text: string;
}

export interface LlmRequest<T> {
  /** Concrete provider model id, already resolved by the router (DESIGN §7). */
  readonly model: string;
  /** Instructions **only**. Never any user-supplied string. */
  readonly system: string;
  readonly userBlocks: readonly LlmUserBlock[];
  readonly output: OutputContract<T>;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** Recorded verbatim on the resulting `usage_events` row. */
  readonly phase: UsagePhase;
}

/** DESIGN §4: every token that was billed, per call. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Zero in v1 — no prompt caching (DESIGN §7) — but reported, not assumed. */
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

export interface LlmResponse<T> {
  readonly structured: T;
  /** Always present. This is the point (DESIGN §7). */
  readonly usage: LlmUsage;
  /** The model that actually served the call, for the usage row. */
  readonly model: string;
  readonly stopReason: LlmStopReason;
}

/** Input for a pre-flight token count. Same shape as a request, minus the output. */
export interface TokenCountRequest {
  readonly model: string;
  readonly system: string;
  readonly userBlocks: readonly LlmUserBlock[];
}

export interface Llm {
  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>>;

  /**
   * DESIGN §7: token counting via the provider's `count_tokens`, never
   * `tiktoken` and never an estimate — Polish tokenizes worse than English and
   * the difference matters. Checked against `MAX_INPUT_TOKENS` before every
   * call, because one 10,000-character message can blow a 500-message budget by
   * itself.
   */
  countTokens(request: TokenCountRequest): Promise<number>;
}
