/**
 * Wires a real `Llm` for the eval runner (DESIGN §7, §12, WS4).
 *
 * `docs/PLAN.md`'s WS13 card depends on WS4, which owns `Llm`'s only
 * production implementation (`src/adapters/outbound/anthropic`) plus the
 * registry shape it reads (`src/application/llm/registry.ts`). This module is
 * the one place in `eval/**` that touches either — everything else
 * (`runner.ts`, fixtures) only ever sees the `Llm` port.
 *
 * No `Config` adapter (WS7) involved: the eval harness is a standalone tool,
 * not a chat, so it needs exactly one registry entry, built here from the
 * same alias/model/env-var shape `config.example.yaml` ships (DESIGN §7:
 * "API keys are env-only, referenced from config by name").
 */
import { AnthropicLlm } from '../src/adapters/outbound/anthropic/anthropic-llm.js';
import type { AnthropicClientFactory } from '../src/adapters/outbound/anthropic/client.js';
import type { ModelRegistry } from '../src/application/llm/registry.js';
import type { Llm } from '../src/application/ports/driven/llm.js';

/** Mirrors `config.example.yaml`'s `models.registry.sonnet` — the reduce/single-shot model (DESIGN §7). */
export const EVAL_MODEL_ALIAS = 'sonnet';
export const EVAL_MODEL_ID = 'claude-sonnet-5';
export const EVAL_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const EVAL_MAX_OUTPUT_TOKENS = 4096;

export function evalModelRegistry(): ModelRegistry {
  return {
    [EVAL_MODEL_ALIAS]: {
      provider: 'anthropic',
      model: EVAL_MODEL_ID,
      apiKeyEnv: EVAL_API_KEY_ENV,
      maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
    },
  };
}

export interface BuildLlmOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test-only: injects a stub client so `llm-client.test.ts` never touches the network. */
  readonly clientFactory?: AnthropicClientFactory;
}

/**
 * `null` when no API key is configured, so `run.ts` can explain the situation
 * in plain language instead of the process crashing on the first call.
 */
export function buildEvalLlm(options: BuildLlmOptions = {}): Llm | null {
  const env = options.env ?? process.env;
  const apiKey = env[EVAL_API_KEY_ENV];
  if (apiKey === undefined || apiKey.length === 0) return null;

  return new AnthropicLlm({
    registry: evalModelRegistry(),
    env,
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
  });
}
