/**
 * `ErrorReporter` — `capture(error, context)` (DESIGN §3, §11).
 *
 * **The context is a closed, typed tag set. It is not `Record<string, unknown>`,
 * and it must never become one.**
 *
 * DESIGN §11: the error sink is a second exfiltration path. Anything attached to
 * an exception leaves the TTL, leaves `/forgetme`'s reach, and lands on a
 * third-party server — the exact laundering path §5 was written to close,
 * arriving through the back door. The type system is the first line of defence
 * and the `beforeSend` tag allowlist is the second; the reason for having both
 * is that the first one is free and catches the mistake at the keyboard.
 *
 * Consequences encoded here:
 *
 * - Identities are `PseudonymLabel`, a branded string that only
 *   `PseudonymStore` can produce. `capture(err, { user: userId })` does not
 *   compile, and neither does passing a display name.
 * - There is no `extra`, no `contexts`, no `tags` escape hatch, and no field
 *   whose type is `string` where the value could be user text. `rangeKind` is
 *   the *shape* of the range (`duration`), never the token the user typed.
 * - Message text, question text, rendered output and raw ids have no field at
 *   all. Attach shapes: counts, tokens, phase, model, prompt version.
 */
import type { ErrorCode } from '../../../domain/errors.js';
import type { PseudonymLabel } from '../../../domain/model/pseudonym.js';
import type { RangeSpecKind } from '../../../domain/model/range.js';
import type { UsagePhase } from '../../../domain/model/usage.js';

/** Where in the pipeline this happened. Closed: new phases are a contract change. */
export type PipelinePhase =
  | 'boot'
  | 'config'
  | 'poll'
  | 'ingest'
  | 'dispatch'
  | 'permissions'
  | 'range'
  | 'guards'
  | 'corpus'
  | 'compaction'
  | 'llm'
  | 'render'
  | 'deliver'
  | 'sweeper'
  | 'shutdown';

/** Which adapter raised it. Closed, and none of these names are user data. */
export type AdapterName =
  | 'telegram_in'
  | 'telegram_out'
  | 'sqlite'
  | 'anthropic'
  | 'config'
  | 'system';

/**
 * The complete set of things that may accompany an error. Every member is a
 * number, a boolean, or a value drawn from a closed union — with the single
 * exception of the model id and the prompt version, which are operator-authored
 * configuration values, not user input.
 */
export interface ErrorContext {
  readonly phase: PipelinePhase;
  readonly adapter?: AdapterName;
  /** Pseudonym only (`quiet-harbor`). A raw `ChatId` does not type-check. */
  readonly chat?: PseudonymLabel;
  /** Pseudonym only (`kind-otter`). A raw `UserId` or a name does not type-check. */
  readonly user?: PseudonymLabel;
  /** Whether a forum topic was involved. The id itself is not interesting enough to risk. */
  readonly inThread?: boolean;
  readonly scopeKind?: 'thread' | 'all';
  readonly intent?: 'summarize' | 'answer';
  /** The *shape* of the range, never the token: `duration`, not `2h`. */
  readonly rangeKind?: RangeSpecKind;
  readonly llmPhase?: UsagePhase;
  /** Concrete model id from the registry (operator-authored). */
  readonly model?: string;
  /** Prompt revision (operator-authored). */
  readonly promptVersion?: string;
  readonly messageCount?: number;
  readonly chunkCount?: number;
  readonly compactionDepth?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly attempt?: number;
  readonly errorCode?: ErrorCode;
  /**
   * Local correlation id for an error whose own message may quote user content
   * (DESIGN §11). The full text stays in local logs; this is the join key.
   */
  readonly correlationId?: string;
}

export interface ErrorReporter {
  /**
   * Report a failure. Implementations must ignore `error.message` for anything
   * that leaves the process and use `safeMessageOf(error)` instead, and must
   * respect `shouldReport(error)` — a 429 with `retry_after`, a 403 on a DM
   * attempt and a bad range token are metrics, not incidents (DESIGN §11).
   */
  capture(error: unknown, context: ErrorContext): void;

  /** Awaited during graceful shutdown, before the lock is released. */
  flush(timeoutMs?: number): Promise<boolean>;

  close(timeoutMs?: number): Promise<boolean>;
}
