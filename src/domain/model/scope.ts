/**
 * Scope of a range (DESIGN §2, "Scope").
 *
 * Ranges are thread-scoped in forum supergroups, with `all` as the escape hatch.
 * `{ kind: 'thread', threadId: null }` is the General topic of a forum, and is
 * also the only possible scope in a non-forum group — the two are the same shape
 * on purpose, because `message_thread_id` is simply absent in both cases.
 */
import type { ThreadId } from './ids.js';

export type Scope =
  | { readonly kind: 'thread'; readonly threadId: ThreadId | null }
  | { readonly kind: 'all' };

export const ALL_TOPICS: Scope = Object.freeze({ kind: 'all' });

export function threadScope(threadId: ThreadId | null): Scope {
  return Object.freeze({ kind: 'thread', threadId });
}

/** True when `message` (by its thread) falls inside `scope`. */
export function scopeMatches(scope: Scope, threadId: ThreadId | null): boolean {
  return scope.kind === 'all' || scope.threadId === threadId;
}
