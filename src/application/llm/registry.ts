/**
 * Model registry (DESIGN §7, WS4).
 *
 * "Registry built from `Config`; keys resolved from `apiKeyEnv`, never inline."
 * This module only deals with the *shape* the registry — alias -> provider
 * entry — the actual environment-variable read happens in the adapter
 * (`src/adapters/outbound/anthropic/**`), because `process.env` is I/O and this
 * is `src/application`, which imports only `domain` and `config` (DESIGN §3,
 * eslint boundaries).
 *
 * `ResolvedConfig['models']` is already Zod-validated and cross-validated
 * (DESIGN §10, `crossValidateResolved`): every routing rule's `use` names a
 * registry alias, every registry entry's `apiKeyEnv` is set, every registry
 * model has a price entry. This module does not repeat that validation — it is
 * the read side, used *after* boot has already refused a bad config.
 */
import { UnknownModelError } from '../../domain/errors.js';
import type { ResolvedConfig } from '../../config/schema.js';

/** The whole `models` config section, as resolved. */
export type ModelsConfig = ResolvedConfig['models'];

/** alias -> provider entry. */
export type ModelRegistry = ModelsConfig['registry'];

/** One registry entry: provider, concrete model id, key env var name, output cap. */
export type ModelRegistryEntry = ModelRegistry[string];

/** An alias resolved to its entry, kept together so callers never lose the alias. */
export interface ResolvedModel {
  readonly alias: string;
  readonly entry: ModelRegistryEntry;
}

/**
 * Looks up a registry alias (e.g. a chat's `models.default` override, or a
 * routing rule's `use`). Throws `UnknownModelError` when the alias is not in
 * the registry — which, downstream of a validated config, means the caller
 * passed a stale or hand-typed alias rather than one taken from config.
 */
export function resolveAlias(registry: ModelRegistry, alias: string): ResolvedModel {
  const entry = registry[alias];
  if (entry === undefined) {
    throw new UnknownModelError(alias);
  }
  return { alias, entry };
}

/**
 * Finds the registry entry for a **concrete provider model id** — what
 * `LlmRequest.model` and `LlmResponse.model` actually carry (DESIGN, WS4: "the
 * router resolves the concrete model id before it reaches `Llm.complete()`").
 * The `Llm` adapter needs this the other way round from `resolveAlias`: given
 * the model id already embedded in a request, which `apiKeyEnv` authenticates
 * it? Returns `null` rather than throwing — the caller decides whether an
 * unresolvable model id is fatal.
 */
export function findByModelId(registry: ModelRegistry, modelId: string): ResolvedModel | null {
  for (const [alias, entry] of Object.entries(registry)) {
    if (entry.model === modelId) return { alias, entry };
  }
  return null;
}

/** `findByModelId`, but throws `UnknownModelError` instead of returning `null`. */
export function requireByModelId(registry: ModelRegistry, modelId: string): ResolvedModel {
  const found = findByModelId(registry, modelId);
  if (found === null) {
    throw new UnknownModelError(modelId);
  }
  return found;
}
