/**
 * Turns compaction progress into throttled `editMessageText` calls on the
 * DESIGN §8 placeholder ("carries map-reduce progress (`kompaktuję 3/7`) —
 * throttled to ~1 edit / 3s, since edits count against the same 20/min group
 * budget").
 *
 * The throttle is wall-clock, via the `Clock` port, not a forced `sleep`
 * between compaction steps — waiting would slow down the actual work for no
 * reason. A report that arrives too soon after the last one that was actually
 * sent is simply dropped, except the very first (so the placeholder stops
 * looking stuck immediately) and the one that completes a round
 * (`done >= total`, so the receipt is never silently swallowed by the
 * throttle).
 */
import type { Temporal } from '../../domain/time/temporal.js';
import type { ChatId, MessageId } from '../../domain/model/ids.js';
import type { ChatGateway } from '../ports/driven/chat-gateway.js';
import type { Clock } from '../ports/driven/clock.js';
import type { CompactionProgress, CompactionProgressReporter } from './types.js';

export interface PlaceholderTarget {
  readonly chatId: ChatId;
  readonly messageId: MessageId;
}

export interface ThrottledProgressReporterOptions {
  readonly gateway: ChatGateway;
  readonly clock: Clock;
  readonly target: PlaceholderTarget;
  /** DESIGN §8: ~1 edit / 3s. Typically `config.get('delivery').editThrottleMs`. */
  readonly throttleMs: number;
  readonly render: (progress: CompactionProgress) => string;
}

export class ThrottledProgressReporter implements CompactionProgressReporter {
  #lastSentAt: Temporal.Instant | null = null;
  readonly #options: ThrottledProgressReporterOptions;

  constructor(options: ThrottledProgressReporterOptions) {
    this.#options = options;
  }

  async report(progress: CompactionProgress): Promise<void> {
    const { clock, gateway, target, throttleMs, render } = this.#options;
    const now = clock.now();
    const isFirst = this.#lastSentAt === null;
    const isComplete = progress.done >= progress.total;
    if (!isFirst && !isComplete) {
      const elapsedMs = now.since(this.#lastSentAt as Temporal.Instant).total({ unit: 'milliseconds' });
      if (elapsedMs < throttleMs) return;
    }
    this.#lastSentAt = now;
    await gateway.editText(target.chatId, target.messageId, { text: render(progress) });
  }
}
