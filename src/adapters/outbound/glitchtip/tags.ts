/**
 * The `ErrorContext` tag allowlist (DESIGN §11).
 *
 * "Allowlist, never blocklist — a blocklist fails open the first time someone
 * adds a field." This is the single list both sides of the boundary use:
 * `glitchtip-reporter.ts` uses it to build the tags a `capture()` call attaches
 * to the Sentry scope, and `scrub-event.ts`'s `beforeSend` hook uses the exact
 * same list to rebuild `event.tags` from scratch before anything leaves the
 * process. One list, so the two can never drift apart.
 *
 * `satisfies readonly (keyof ErrorContext)[]` means the port and this list are
 * checked against each other at compile time: add a field to `ErrorContext`
 * without adding it here and the port still compiles (the list is allowed to be
 * a *subset*), but typo a key here and it fails to compile.
 */
import type { ErrorContext } from '../../../application/ports/driven/error-reporter.js';

export const ALLOWED_TAG_KEYS = [
  'phase',
  'adapter',
  'chat',
  'user',
  'inThread',
  'scopeKind',
  'intent',
  'rangeKind',
  'llmPhase',
  'model',
  'promptVersion',
  'messageCount',
  'chunkCount',
  'compactionDepth',
  'inputTokens',
  'outputTokens',
  'httpStatus',
  'retryAfterSeconds',
  'attempt',
  'errorCode',
  'correlationId',
] as const satisfies readonly (keyof ErrorContext)[];

export type AllowedTagKey = (typeof ALLOWED_TAG_KEYS)[number];

const ALLOWED_TAG_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);

export function isAllowedTagKey(key: string): key is AllowedTagKey {
  return ALLOWED_TAG_KEY_SET.has(key);
}

/**
 * The tags a single `capture()` call attaches, as plain strings (Sentry tag
 * values are primitives; strings are the simplest thing that survives a round
 * trip through the transport unchanged).
 *
 * `defaultPromptVersion` satisfies DESIGN §11's "tag every event with ...
 * `prompt_version`" for the phases that never pass one explicitly (a boot or
 * config failure has no prompt in play yet, but the running release did).
 */
export function buildTags(
  context: ErrorContext,
  defaultPromptVersion: string,
): Record<string, string> {
  const merged: ErrorContext = {
    ...context,
    promptVersion: context.promptVersion ?? defaultPromptVersion,
  };
  const tags: Record<string, string> = {};
  for (const key of ALLOWED_TAG_KEYS) {
    const value = merged[key];
    if (value !== undefined) tags[key] = String(value);
  }
  return tags;
}
