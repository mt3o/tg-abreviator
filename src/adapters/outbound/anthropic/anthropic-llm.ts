/**
 * `Llm` adapter over `@anthropic-ai/sdk` (DESIGN §3, §7, WS4).
 *
 * Three things this file is careful about, because they are exactly what the
 * card calls out:
 *
 * 1. **Structured output only, via `output_config.format`** (DESIGN §6.7): the
 *    request always carries a `json_schema` format built from the caller's
 *    `OutputContract`, so there is no free-text channel.
 * 2. **`system` and `userBlocks` never mix.** `request.system` goes straight
 *    into the SDK's `system` parameter; `request.userBlocks` become the *only*
 *    `user` message, each wrapped in its own delimiter tag by
 *    `buildUserMessage` (`mapping.ts`). Nothing here concatenates the two.
 * 3. **Usage comes back on every call** (DESIGN §7) — `mapUsage` runs
 *    unconditionally on the response, map phase included.
 *
 * API keys are resolved from `env[registryEntry.apiKeyEnv]` at call time, never
 * embedded in config (DESIGN §7). Clients are cached per env-var name so a
 * repeated call does not re-authenticate.
 */
import { extractResponseText, mapProviderError, mapStopReason, mapUsage, buildUserMessage } from './mapping.js';
import { defaultAnthropicClientFactory } from './client.js';
import { requireByModelId } from '../../../application/llm/registry.js';
import { LlmInvalidResponseError, MissingEnvError } from '../../../domain/errors.js';
import type { AnthropicClientFactory, AnthropicClientLike } from './client.js';
import type { ModelRegistry } from '../../../application/llm/registry.js';
import type {
  Llm,
  LlmRequest,
  LlmResponse,
  TokenCountRequest,
} from '../../../application/ports/driven/llm.js';

export interface AnthropicLlmOptions {
  /** alias -> provider entry, straight from `ResolvedConfig.models.registry`. */
  readonly registry: ModelRegistry;
  /** The process environment (or a test double), read only for `apiKeyEnv` names. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Passed to the client factory; the SDK's own retry budget before an error surfaces. */
  readonly maxRetries?: number;
  /** Overridable for tests — see `client.ts`. Defaults to a real `Anthropic` client. */
  readonly clientFactory?: AnthropicClientFactory;
}

export class AnthropicLlm implements Llm {
  readonly #registry: ModelRegistry;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #maxRetries: number;
  readonly #clientFactory: AnthropicClientFactory;
  readonly #clients = new Map<string, AnthropicClientLike>();

  constructor(options: AnthropicLlmOptions) {
    this.#registry = options.registry;
    this.#env = options.env;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#clientFactory = options.clientFactory ?? defaultAnthropicClientFactory;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const client = this.#clientFor(request.model);

    let message;
    try {
      message = await client.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [buildUserMessage(request.userBlocks)],
        output_config: { format: { type: 'json_schema', schema: { ...request.output.jsonSchema } } },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });
    } catch (error) {
      throw mapProviderError(error, this.#maxRetries + 1);
    }

    const text = extractResponseText(message);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new LlmInvalidResponseError(request.output.name, { cause });
    }

    let structured: T;
    try {
      structured = request.output.parse(raw);
    } catch (cause) {
      throw new LlmInvalidResponseError(request.output.name, { cause });
    }

    return {
      structured,
      usage: mapUsage(message.usage),
      model: message.model,
      stopReason: mapStopReason(message.stop_reason),
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    const client = this.#clientFor(request.model);

    try {
      const result = await client.messages.countTokens({
        model: request.model,
        system: request.system,
        messages: [buildUserMessage(request.userBlocks)],
      });
      return result.input_tokens;
    } catch (error) {
      throw mapProviderError(error, this.#maxRetries + 1);
    }
  }

  /** Resolves the registry entry for a concrete model id, authenticates, and caches the client by `apiKeyEnv`. */
  #clientFor(modelId: string): AnthropicClientLike {
    const resolved = requireByModelId(this.#registry, modelId);
    const apiKeyEnv = resolved.entry.apiKeyEnv;

    const cached = this.#clients.get(apiKeyEnv);
    if (cached !== undefined) return cached;

    const apiKey = this.#env[apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new MissingEnvError(apiKeyEnv);
    }

    const client = this.#clientFactory(apiKey, this.#maxRetries);
    this.#clients.set(apiKeyEnv, client);
    return client;
  }
}
