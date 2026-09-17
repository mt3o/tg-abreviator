/**
 * Types for map-reduce compaction (DESIGN §7 "Compaction", WS11).
 *
 * `Compactor.compact()` (`compactor.ts`) is only ever invoked once the caller
 * (WS10's `summarize-range` / `answer-question` use cases) has already decided
 * the corpus is over `COMPACT_THRESHOLD` — "under threshold -> single call;
 * over -> hand off to WS11 after warning" (PLAN, WS10 card). Everything below
 * this threshold decision belongs to this module.
 */
import type { ChatId, MessageId, ThreadId } from '../../domain/model/ids.js';
import type { AnswerContent } from '../../domain/model/answer.js';
import type { StoredMessage } from '../../domain/model/message.js';
import type { TimeZoneId } from '../../domain/time/temporal.js';
import type { LlmUsage } from '../ports/driven/llm.js';
import type { PromptIntent, PromptLanguage } from '../prompts/system-prompt.js';

/** DESIGN §7: "Map phase uses a cheap model, the reduce phase the strong one." */
export interface CompactionModels {
  /** Concrete provider model id for every leaf (map) call. */
  readonly map: string;
  /** Concrete provider model id for every combine and final (reduce) call. */
  readonly reduce: string;
}

/**
 * A compacted node anywhere in the tree: a map-phase leaf over raw messages,
 * or a reduce-phase combination of earlier nodes. Both are addressable by the
 * same `[threadId, firstMsgId, lastMsgId]` shape `ChunkStore` already uses
 * (DESIGN §4 `chunks`), which is what lets every level of the recursion share
 * one cache.
 */
export interface ChunkNode {
  readonly threadId: ThreadId | null;
  readonly firstMsgId: MessageId;
  readonly lastMsgId: MessageId;
  readonly text: string;
}

export interface CompactionRequest {
  readonly chatId: ChatId;
  /**
   * The whole assembled corpus for the resolved range — already thread-scoped
   * (or not, for an `all`-scoped range), opt-out-filtered and bot-excluded by
   * the caller (DESIGN §6.3, §6.4). May span more than one thread when the
   * range is `all`-scoped; `Compactor` partitions by thread itself so one
   * chunk never silently spans two forum topics.
   */
  readonly messages: readonly StoredMessage[];
  readonly timeZone: TimeZoneId;
  /** DESIGN §7: "One threshold applied recursively at every level." In tokens. */
  readonly compactThreshold: number;
  /** DESIGN §7: 6h by default; `bucketByTime`'s own default applies if omitted. */
  readonly bucketHours?: number;
  readonly models: CompactionModels;
  readonly maxOutputTokens: number;
  /** DESIGN §7: part of the chunk cache key, "or you serve summaries from a prompt you have since fixed". */
  readonly promptVersion: string;
  readonly language: PromptLanguage;
  readonly intent: PromptIntent;
  /** Required (non-null, non-empty) when `intent === 'answer'`; ignored otherwise. */
  readonly question: string | null;
  /**
   * Turns one bucket's raw messages into the `<transcript>` text handed to a
   * map-phase call. Defaults to a minimal internal `[HH:MM] Name: text`
   * formatter (`format-transcript.ts`) so this module is fully self-contained;
   * a caller with a richer renderer (gap disclosure, media captions, …) may
   * override it.
   */
  readonly formatBucket?: (messages: readonly StoredMessage[], timeZone: TimeZoneId) => string;
  readonly progress?: CompactionProgressReporter;
}

/** One `Llm.complete()` call this compaction made, or one cache hit that skipped one. */
export interface CompactionCallRecord {
  readonly phase: 'map' | 'reduce';
  /** 0 for every map call; the reduce round number (1-based) for a reduce call. */
  readonly level: number;
  readonly model: string;
  readonly cached: boolean;
  /** `null` exactly when `cached` is `true` — a cache hit never calls the provider. */
  readonly usage: LlmUsage | null;
}

export interface CompactionResult {
  readonly content: AnswerContent;
  /** The concrete model id that produced `content` — always `models.reduce`. */
  readonly model: string;
  readonly promptVersion: string;
  /** Every call and every cache hit, in the order they happened. */
  readonly calls: readonly CompactionCallRecord[];
  /** Number of leaf (map-phase) chunks the corpus was split into. */
  readonly leafChunkCount: number;
  /** Number of reduce rounds performed before the final call. 0 when the leaves fed straight into it. */
  readonly levels: number;
}

export interface CompactionProgress {
  readonly phase: 'map' | 'reduce';
  readonly level: number;
  readonly done: number;
  readonly total: number;
}

/**
 * DESIGN §8: "carries map-reduce progress (`kompaktuję 3/7`)". `Compactor`
 * reports through this after every leaf and every reduce-round item; turning
 * that into a throttled `editMessageText` call is `ThrottledProgressReporter`
 * (`progress.ts`).
 */
export interface CompactionProgressReporter {
  report(progress: CompactionProgress): Promise<void>;
}
