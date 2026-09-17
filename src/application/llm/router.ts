/**
 * Model router (DESIGN §7, WS4).
 *
 * "Provider/model registry in config with an ordered `[{when, use}]` routing
 * rule list, first match wins, plus a default. A small rule list, not a DSL."
 * "Map phase uses a cheap model, the reduce phase the strong one."
 *
 * This is where that ordered list turns into a concrete model. The result
 * (`ResolvedModel`, from `registry.ts`) carries the **concrete provider model
 * id** that `LlmRequest.model` expects — routing happens before
 * `Llm.complete()` is ever called, not inside the adapter (DESIGN §7, the
 * `Llm` port's own docstring: "Concrete provider model id, already resolved by
 * the router").
 */
import { resolveAlias } from './registry.js';
import type { ModelsConfig, ResolvedModel } from './registry.js';
import type { ChatId } from '../../domain/model/ids.js';

/**
 * The phases a routing rule can target. Deliberately narrower than
 * `UsagePhase` (DESIGN §4): `count_tokens` and `feedback` never carry a
 * generation call, so they are never something a routing rule chooses a model
 * for — `count_tokens` reuses whatever model the caller already resolved, and
 * `feedback` calls no model at all. Kept in sync with the `when.phase` enum in
 * `src/config/schema.ts` (`modelsSection` -> `routingRuleSchema`) by
 * `router.test.ts`.
 */
export type RoutablePhase = 'single' | 'map' | 'reduce';

/** One entry of `models.routing`, as resolved config carries it. */
export type RoutingRule = ModelsConfig['routing'][number];

export interface RouteContext {
  readonly phase: RoutablePhase;
  readonly chatId: ChatId;
  /**
   * Pre-flight token count, when known (DESIGN §7: `count_tokens` runs before
   * every call). Rules with a `minInputTokens` clause never match without it.
   */
  readonly inputTokens?: number;
}

function ruleMatches(when: RoutingRule['when'], ctx: RouteContext): boolean {
  if (when.phase !== undefined && when.phase !== ctx.phase) return false;
  if (when.chatId !== undefined && when.chatId !== ctx.chatId) return false;
  if (when.minInputTokens !== undefined) {
    if (ctx.inputTokens === undefined || ctx.inputTokens < when.minInputTokens) return false;
  }
  return true;
}

/**
 * First match wins; falls back to `models.default` when nothing matches (or
 * `models.routing` is empty). Never a DSL: this is the entire evaluator.
 */
export function selectAlias(models: ModelsConfig, ctx: RouteContext): string {
  for (const rule of models.routing) {
    if (ruleMatches(rule.when, ctx)) return rule.use;
  }
  return models.default;
}

/** `selectAlias`, resolved all the way to a concrete model entry. */
export function routeModel(models: ModelsConfig, ctx: RouteContext): ResolvedModel {
  const alias = selectAlias(models, ctx);
  return resolveAlias(models.registry, alias);
}
