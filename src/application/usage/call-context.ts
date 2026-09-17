/**
 * Ambient per-invocation context for `UsageRecordingLlm` (`usage-recording-llm.ts`).
 *
 * `Llm.complete()` (`src/application/ports/driven/llm.ts`) carries `model`,
 * `system`, `userBlocks` and `phase` — deliberately no `chatId`, because the
 * port is Phase 0's and nothing in the LLM request shape is chat-specific.
 * Map-reduce compaction (WS11) and the single-shot pipeline (WS10) can each
 * call `Llm.complete()` more than once per user invocation, and every one of
 * those calls has to land in `usage_events` against the *same* chat/thread/
 * range/question it was made on behalf of.
 *
 * Rather than threading a context parameter through every port and every
 * workstream's call sites — which would mean editing frozen Phase 0 contracts
 * — the guarded pipeline (`src/application/guards/guarded-pipeline.ts`) wraps
 * one whole invocation of `SummarizeRange`/`AnswerQuestion` in
 * `runWithUsageContext`, and `UsageRecordingLlm` reads it back via
 * `currentUsageContext()` on every `complete()`/`countTokens()` call that
 * happens inside that invocation — however many workstreams' code sits
 * between the two. `AsyncLocalStorage` is exactly the built-in for this: it
 * survives `await` boundaries and is per-async-chain, so two chats' concurrent
 * requests (should concurrency ever allow that) never see each other's
 * context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ChatId, ThreadId, UserId } from '../../domain/model/ids.js';

export interface UsageCallContext {
  readonly chatId: ChatId;
  readonly threadId: ThreadId | null;
  /** Who invoked the bot. `usage_events.user_id` until `/forgetme` anonymises it. */
  readonly userId: UserId;
  /** The raw range token as typed (DESIGN §9: dedupe/audit key on the raw token). */
  readonly rangeSpec: string;
  /** Verbatim question, or `null` for a summarize call. Never stored as text (§4). */
  readonly question: string | null;
}

const storage = new AsyncLocalStorage<UsageCallContext>();

/** Runs `fn` with `context` visible to every `currentUsageContext()` call inside it. */
export async function runWithUsageContext<T>(
  context: UsageCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  return await storage.run(context, fn);
}

/** `undefined` outside any `runWithUsageContext` call — e.g. a health-check ping. */
export function currentUsageContext(): UsageCallContext | undefined {
  return storage.getStore();
}
