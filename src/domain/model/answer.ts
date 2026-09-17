/**
 * What the model returns and what the user gets back (DESIGN §6.7, §8, §12).
 *
 * The provider is asked for **structured output with fixed fields** so that
 * there is no free-text channel for "output this instead" and no way to leak the
 * system prompt (DESIGN §6.7). `AnswerContent` is that fixed shape; the
 * rendering rules that turn it into Telegram HTML are WS5's
 * (`src/domain/render/**`).
 */
import type { ChatId, MessageId, ThreadId } from './ids.js';
import type { RangeSpec, ResolvedRange } from './range.js';
import type { Scope } from './scope.js';

/**
 * The model's own read of the exchange. Separate from slur substitution on
 * purpose (DESIGN §6.6): baby-talk the words, keep the temperature honest — a
 * heated exchange still gets a `⚠️` in the header.
 */
export type Tone = 'neutral' | 'heated' | 'playful' | 'technical' | 'mixed';

export const TONES: readonly Tone[] = Object.freeze([
  'neutral',
  'heated',
  'playful',
  'technical',
  'mixed',
] as const);

/** Reduce-phase / single-shot structured output. */
export interface AnswerContent {
  /** DESIGN §8: the reduce step is instructed to stay under ~3000 characters. */
  readonly summary: string;
  readonly keyPoints: readonly string[];
  /**
   * What the corpus did not answer. DESIGN §6.13: never assert absence as fact —
   * "I don't see a decision in this range", not "nobody decided anything".
   */
  readonly unanswered: readonly string[];
  readonly tone: Tone;
}

/** Map-phase structured output: one bucket, compacted. */
export interface ChunkSummaryContent {
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly tone: Tone;
}

/** DESIGN §9: a served-from-cache answer is labelled `↺ odpowiedź sprzed N min`. */
export interface CachedMarker {
  readonly ageMinutes: number;
}

/**
 * Everything the header needs (DESIGN §2: "Every answer carries a header stating
 * the resolved scope … A wrong guess must be visible").
 */
export interface AnswerMeta {
  readonly chatId: ChatId;
  readonly scope: Scope;
  /** Forum topic name, when the adapter knows it. Renders as `Topic: Deploys`. */
  readonly topicLabel: string | null;
  readonly range: ResolvedRange;
  readonly spec: RangeSpec;
  /** Messages actually fed to the model, after opt-out and bot filtering. */
  readonly messageCount: number;
  /** DESIGN §4: any range overlapping a gap gets an explicit line in the output. */
  readonly gapCount: number;
  readonly cached: CachedMarker | null;
  /** Concrete provider model id that produced the final answer. */
  readonly model: string;
  readonly promptVersion: string;
}

export interface Answer {
  readonly content: AnswerContent;
  readonly meta: AnswerMeta;
}

/** Where the answer was delivered, for the use-case result and for tests. */
export interface DeliveredAnswer {
  readonly answer: Answer;
  readonly delivery: 'in_chat' | 'dm' | 'in_chat_after_dm_failure';
  readonly threadId: ThreadId | null;
  readonly messageIds: readonly MessageId[];
}
