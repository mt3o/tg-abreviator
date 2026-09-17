/**
 * The Anthropic SDK client, behind the narrowest interface this adapter
 * actually uses (DESIGN §3: no `@anthropic-ai/sdk` type may cross the
 * `application`/`adapters` boundary — this file is the one place that knows
 * the real client exists, and `anthropic-llm.ts` only ever sees
 * `AnthropicClientLike`).
 *
 * Narrowing the interface also makes the adapter testable without a network:
 * tests hand `AnthropicLlm` a `clientFactory` that returns an object literal
 * satisfying `AnthropicClientLike`, never a real `Anthropic` instance.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageCountTokensParams,
  MessageTokensCount,
} from '@anthropic-ai/sdk/resources/messages';

export interface AnthropicClientLike {
  readonly messages: {
    create(params: MessageCreateParamsNonStreaming): Promise<Message>;
    countTokens(params: MessageCountTokensParams): Promise<MessageTokensCount>;
  };
}

/** Builds a real client for one resolved API key. `maxRetries` matches DESIGN §11's "report after retries". */
export type AnthropicClientFactory = (apiKey: string, maxRetries: number) => AnthropicClientLike;

export const defaultAnthropicClientFactory: AnthropicClientFactory = (apiKey, maxRetries) =>
  new Anthropic({ apiKey, maxRetries });
