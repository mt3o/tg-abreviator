/**
 * The `usage_events` writer (DESIGN §4, §9).
 *
 * "`usage_events` is a per-call event log... only the question *hash* is
 * stored, never the text... `unit_prices_json` is stored per row so editing
 * the config price table does not silently rewrite last month's history."
 *
 * This is the one place a `UsageEvent` gets constructed. Callers supply the
 * billed tokens (from `Llm.complete()`'s `LlmUsage`, never estimated) and the
 * price table entry in force *right now* — the row freezes both at write
 * time, which is the whole point of storing prices per row instead of joining
 * against the live config table.
 */
import { computeCostMicros } from '../../domain/cost.js';
import { hashQuestion } from '../../domain/dedupe.js';
import { asUsageEventId } from '../../domain/model/ids.js';
import type { ChatId, ThreadId, UserId } from '../../domain/model/ids.js';
import { userRef } from '../../domain/model/usage.js';
import type { UnitPrices, UsageEvent, UsagePhase, UsageStatus } from '../../domain/model/usage.js';
import type { Clock } from '../ports/driven/clock.js';
import type { IdGenerator } from '../ports/driven/id-generator.js';
import type { UsageStore } from '../ports/driven/usage-store.js';

export interface RecordUsageInput {
  readonly chatId: ChatId;
  readonly threadId: ThreadId | null;
  readonly userId: UserId;
  /** Concrete provider model id, never the alias (DESIGN §4). */
  readonly model: string;
  readonly phase: UsagePhase;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Zero unless the call actually read from a cache (DESIGN §7: none in v1). */
  readonly cacheReadTokens?: number;
  readonly unitPrices: UnitPrices;
  /** The raw range token as typed (`RangeSpec.raw`), or `''` when there was none. */
  readonly rangeSpec: string;
  /** Verbatim question, hashed here — never stored or passed on as text. */
  readonly question: string | null;
  readonly status: UsageStatus;
}

/**
 * Builds and appends one `usage_events` row. Returns the row that was
 * written, so a caller that also wants it for the dedupe cache or a test
 * assertion does not have to reconstruct it.
 */
export async function recordUsage(
  usage: UsageStore,
  idGenerator: IdGenerator,
  clock: Clock,
  input: RecordUsageInput,
): Promise<UsageEvent> {
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const costMicros = computeCostMicros(
    { inputTokens: input.inputTokens, outputTokens: input.outputTokens, cacheReadTokens },
    input.unitPrices,
  );

  const event: UsageEvent = {
    id: asUsageEventId(idGenerator.uuid()),
    ts: clock.now(),
    chatId: input.chatId,
    threadId: input.threadId,
    user: userRef(input.userId),
    model: input.model,
    phase: input.phase,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costMicros,
    unitPrices: input.unitPrices,
    rangeSpec: input.rangeSpec,
    questionHash: hashQuestion(input.question),
    status: input.status,
  };

  await usage.record(input.chatId, event);
  return event;
}

/** A zero-cost record, for `count_tokens` calls and cache hits (DESIGN §4, §7, §9). */
export function zeroPrices(): UnitPrices {
  return { inputPerMTokUsd: 0, outputPerMTokUsd: 0, cacheReadPerMTokUsd: 0 };
}
