/**
 * The shape of "somebody invoked the bot" (DESIGN §2).
 *
 * Driving ports are what the outside calls in through. Everything here is
 * already domain vocabulary: the Telegram adapter has done its mapping, so no
 * grammY type reaches a use case.
 *
 * The range is already *parsed* by the time a command is built. Parsing is a
 * pure domain function (`src/domain/range/**`, WS3) and the dispatcher has to
 * run it anyway to decide whether this is a summarize or an answer — range and
 * intent are orthogonal (DESIGN §2), and the only thing that distinguishes them
 * is whether free text followed the leading token. Resolution (`RangeSpec` →
 * `ResolvedRange`) stays inside the use case, where the `Clock` and the stores
 * are.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, MessageId, ThreadId, UserId } from '../../../domain/model/ids.js';
import type { ParsedArguments } from '../../../domain/model/range.js';
import type { Tier } from '../../../domain/model/tier.js';

export interface Invoker {
  readonly userId: UserId;
  /** As Telegram reported it. In-chat output may use it; the error sink may not. */
  readonly displayName: string | null;
  /** Already resolved by the dispatcher via `getChatMember` + operator ids. */
  readonly tier: Tier;
}

export interface InvocationContext {
  readonly chatId: ChatId;
  /** The topic the user is standing in. Replies echo it (DESIGN §2). */
  readonly threadId: ThreadId | null;
  readonly invokedMessageId: MessageId;
  /** Set when the command was sent as a reply: the range anchor (DESIGN §2). */
  readonly replyToMessageId: MessageId | null;
  readonly invoker: Invoker;
  /** Everything after the command token, verbatim. Kept for the dedupe key. */
  readonly rawArgs: string;
  readonly receivedAt: Temporal.Instant;
}

export interface RangeInvocation {
  readonly invocation: InvocationContext;
  readonly parsed: ParsedArguments;
}
