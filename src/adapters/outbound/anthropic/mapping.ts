/**
 * Request/response mapping between the `Llm` port and the Anthropic SDK
 * (DESIGN §3, §7, WS4). Everything that knows an SDK type lives here or in
 * `client.ts`; `anthropic-llm.ts` composes these with the port.
 */
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmProviderError,
  LlmRateLimitedError,
} from '../../../domain/errors.js';
import type { LlmStopReason, LlmUsage, LlmUserBlock } from '../../../application/ports/driven/llm.js';
import type { Message, MessageParam, StopReason, TextBlockParam, Usage } from '@anthropic-ai/sdk/resources/messages';

/**
 * `LlmUserBlock.kind` becomes the XML-style delimiter tag (DESIGN, the `Llm`
 * port's own docstring: "`kind` becomes the delimiter (`<transcript>`,
 * `<question>`) and marks the content as untrusted data in the prompt").
 * `system-prompt.ts`'s `untrustedDataBlock()` tells the model exactly what to
 * expect here — the two must agree, so both name the same four kinds.
 */
export function wrapUserBlock(block: LlmUserBlock): TextBlockParam {
  const tag = block.kind;
  return { type: 'text', text: `<${tag}>\n${block.text}\n</${tag}>` };
}

/** One `user` turn, one content block per `LlmUserBlock`, in order. */
export function buildUserMessage(blocks: readonly LlmUserBlock[]): MessageParam {
  return { role: 'user', content: blocks.map(wrapUserBlock) };
}

const KNOWN_STOP_REASONS: ReadonlySet<LlmStopReason> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'refusal',
]);

/** Anthropic's `StopReason` is a superset of the port's `LlmStopReason`; anything else collapses to `'other'`. */
export function mapStopReason(reason: StopReason | null): LlmStopReason {
  if (reason !== null && KNOWN_STOP_REASONS.has(reason as LlmStopReason)) {
    return reason as LlmStopReason;
  }
  return 'other';
}

/** DESIGN §7: usage is reported, never assumed — cache fields default to zero (no caching in v1). */
export function mapUsage(usage: Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** The first (and expected only) text block of a structured-output response. */
export function extractResponseText(message: Message): string {
  for (const block of message.content) {
    if (block.type === 'text') return block.text;
  }
  throw new Error('anthropic response carried no text content block');
}

function retryAfterSecondsFrom(headers: Headers | undefined): number | null {
  const raw = headers?.get('retry-after') ?? null;
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns whatever the SDK throws into the app's own error taxonomy (DESIGN §7,
 * §11). `RateLimitError` maps to `LlmRateLimitedError` (not reported — DESIGN
 * §11: "expected and handled"); every other `APIError` maps to
 * `LlmProviderError` (reported, after the SDK's own retries are exhausted).
 * Anything that is not an `APIError` at all (a bug in this adapter, a
 * programmer error) is rethrown unchanged rather than mislabelled.
 */
export function mapProviderError(error: unknown, attempts: number): unknown {
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmRateLimitedError(retryAfterSecondsFrom(error.headers), { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmProviderError(error.status ?? null, attempts, { cause: error });
  }
  return error;
}
