/**
 * The stored message (DESIGN §4, `messages`).
 *
 * A Telegram `Message` becomes a `StoredMessage` at the adapter boundary and
 * nothing downstream knows Telegram exists (DESIGN §3).
 *
 * `null` rather than `undefined` throughout: these fields are columns, and a
 * column is either a value or NULL. It keeps the store adapters and the fakes
 * from disagreeing about which absent is which.
 */
import { Temporal } from '../time/temporal.js';
import type { ChatId, MessageId, ThreadId, UserId } from './ids.js';

/**
 * DESIGN §4: `kind: text | photo | sticker | voice | ... | gap_marker | redacted`.
 *
 * Media is stored as the caption plus this placeholder — never the file
 * (DESIGN §4, "Media"). A summary can say "Ola sent a photo" without the
 * operator hosting anyone's pictures.
 */
export type MessageKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'animation'
  | 'audio'
  | 'voice'
  | 'video_note'
  | 'document'
  | 'sticker'
  | 'poll'
  | 'location'
  | 'contact'
  | 'dice'
  | 'game'
  | 'service'
  /** A hole in the corpus, inserted on startup after downtime (DESIGN §4). */
  | 'gap_marker'
  /** The entire body matched a secret shape and was replaced (DESIGN §6.2). */
  | 'redacted';

export const MESSAGE_KINDS: readonly MessageKind[] = Object.freeze([
  'text',
  'photo',
  'video',
  'animation',
  'audio',
  'voice',
  'video_note',
  'document',
  'sticker',
  'poll',
  'location',
  'contact',
  'dice',
  'game',
  'service',
  'gap_marker',
  'redacted',
] as const);

/**
 * Kinds that are not a human utterance.
 *
 * DESIGN §2: `-N` counts stored human messages only — not the bot's own output,
 * not service messages. Pass this as `excludeKinds` when counting or fetching
 * for a `-N` range.
 */
export const NON_HUMAN_MESSAGE_KINDS: readonly MessageKind[] = Object.freeze([
  'service',
  'gap_marker',
] as const);

export function isMessageKind(value: string): value is MessageKind {
  return (MESSAGE_KINDS as readonly string[]).includes(value);
}

export interface StoredMessage {
  readonly chatId: ChatId;
  readonly messageId: MessageId;
  /** `null` for General / non-forum chats. */
  readonly threadId: ThreadId | null;
  /** `null` for synthetic rows (gap markers) and channel-style posts. */
  readonly userId: UserId | null;
  /** Display name as seen at ingest time. Never sent to the error sink (DESIGN §11). */
  readonly displayName: string | null;
  /** Telegram's `date`, as an instant. Ordering key together with `messageId`. */
  readonly ts: Temporal.Instant;
  readonly replyToMessageId: MessageId | null;
  readonly kind: MessageKind;
  /** Text, or a media caption, or `null`. Secrets are already `[redacted]` here. */
  readonly text: string | null;
}

/**
 * The canonical ordering of a corpus: by timestamp, then by message id.
 *
 * Message id alone is not enough, because synthetic rows (gap markers) carry
 * negative ids yet belong at their real point in time. Timestamp alone is not
 * enough, because Telegram's `date` has one-second resolution and a busy chat
 * produces ties. Every store implementation returns rows in this order and the
 * port-conformance suite asserts it.
 */
export function compareMessages(a: StoredMessage, b: StoredMessage): number {
  const byTime = Temporal.Instant.compare(a.ts, b.ts);
  if (byTime !== 0) return byTime;
  return a.messageId - b.messageId;
}
