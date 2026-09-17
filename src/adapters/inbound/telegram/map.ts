/**
 * `Update` -> `StoredMessage` mapping (DESIGN §3, §4, §6.2).
 *
 * **The whole point of this workstream:** this is the only file in the
 * codebase allowed to know both vocabularies — grammY's Telegram types and the
 * domain's `StoredMessage` — at once. Everything downstream of `poller.ts`
 * calling into `application`/`domain` sees only plain domain values.
 *
 * Every function here is pure: no store, no gateway, no clock port. Time comes
 * from the message itself (`message.date`), which is why nothing here needs a
 * `Clock` — the instant being mapped is not "now", it is "when Telegram says
 * this happened".
 */
import { Temporal } from '../../../domain/time/temporal.js';
import { asChatId, asMessageId, asOptionalThreadId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { MessageKind, StoredMessage } from '../../../domain/model/message.js';
import type { Message as TelegramMessage, Update, User as TelegramUser } from 'grammy/types';

/* -------------------------------------------------------------------------- */
/* Secret redaction (DESIGN §6.2)                                             */
/* -------------------------------------------------------------------------- */

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * "API-key / token / IBAN / card / long-digit shapes are stored as
 * `[redacted]`. The DB should not hold them either." (DESIGN §6.2)
 *
 * Order matters: patterns run in sequence against the progressively-redacted
 * string, so a value already turned into the literal `[redacted]` cannot be
 * re-matched by a later, broader pattern.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    // Recognisable provider key prefixes: Anthropic, OpenAI, GitHub, Slack,
    // AWS, Google. Checked first and narrowly, so a false positive here is
    // very unlikely.
    name: 'api_key',
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g,
  },
  {
    // A generic bearer-style token or secret blob: long, mixes letters and
    // digits, no internal whitespace. Requiring both a letter and a digit
    // keeps this from matching an ordinary long word.
    name: 'generic_token',
    pattern:
      /\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    // IBAN: two letters, two check digits, up to 30 alphanumerics.
    name: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  },
  {
    // Card-number-shaped digit groups, optionally space- or dash-separated.
    name: 'card_grouped',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
  },
  {
    // Any other long run of contiguous digits: phone numbers, account
    // numbers, the digit-only remainder of a card or IBAN. DESIGN §6.2 names
    // this explicitly as its own shape.
    name: 'long_digits',
    pattern: /\b\d{9,}\b/g,
  },
];

const REDACTED_PLACEHOLDER = '[redacted]';

export interface RedactionResult {
  readonly text: string;
  /**
   * True when the entire body (ignoring surrounding whitespace) matched a
   * secret shape — the `kind: 'redacted'` case in `message.ts`: "the entire
   * body matched a secret shape and was replaced". A partial match leaves the
   * row's kind untouched and just substitutes the matched span.
   */
  readonly wholeBodyRedacted: boolean;
}

/** Applied to message text and media captions alike, before anything is stored. */
export function redactSecrets(rawText: string): RedactionResult {
  let redacted = rawText;
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, REDACTED_PLACEHOLDER);
  }
  const trimmedOriginal = rawText.trim();
  const wholeBodyRedacted =
    trimmedOriginal.length > 0 && redacted !== rawText && redacted.trim() === REDACTED_PLACEHOLDER;
  return { text: redacted, wholeBodyRedacted };
}

/* -------------------------------------------------------------------------- */
/* Kind detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * DESIGN §4: "Media: store the caption and a `kind` placeholder. Never the
 * file." So this only ever inspects which field is *present*, never its
 * contents — the file id itself never reaches a `StoredMessage`.
 *
 * Order matters: `animation` messages also carry `document` for backward
 * compatibility (per the Bot API docs), so the narrower type must be checked
 * first.
 */
export function detectMessageKind(message: TelegramMessage): MessageKind {
  if (message.text !== undefined) return 'text';
  if (message.photo !== undefined) return 'photo';
  if (message.video !== undefined) return 'video';
  if (message.animation !== undefined) return 'animation';
  if (message.voice !== undefined) return 'voice';
  if (message.audio !== undefined) return 'audio';
  if (message.video_note !== undefined) return 'video_note';
  if (message.document !== undefined) return 'document';
  if (message.sticker !== undefined) return 'sticker';
  if (message.poll !== undefined) return 'poll';
  if (message.location !== undefined) return 'location';
  if (message.contact !== undefined) return 'contact';
  if (message.dice !== undefined) return 'dice';
  if (message.game !== undefined) return 'game';
  // Everything else Telegram sends as a "message" that is not a human
  // utterance: joins/leaves, pinned-message notices, forum topic events, a
  // title change, and so on. DESIGN §4 groups all of these as `service`.
  return 'service';
}

function textOrCaptionOf(message: TelegramMessage, kind: MessageKind): string | null {
  if (kind === 'text') return message.text ?? null;
  // `CaptionableMessage` covers audio/document/photo/video/voice/animation.
  return message.caption ?? null;
}

/* -------------------------------------------------------------------------- */
/* Display name                                                               */
/* -------------------------------------------------------------------------- */

function displayNameOf(message: TelegramMessage): string | null {
  const from = message.from;
  if (from !== undefined) {
    const named = displayNameOfUser(from);
    if (named !== null) return named;
  }
  // Anonymous admin posts and channel-linked messages carry `sender_chat`
  // instead of `from`; `userId` stays null either way (StoredMessage docs).
  const senderChat = message.sender_chat;
  if (senderChat !== undefined && 'title' in senderChat) return senderChat.title ?? null;
  return null;
}

function displayNameOfUser(user: TelegramUser): string | null {
  const parts = [user.first_name, user.last_name].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (parts.length > 0) return parts.join(' ');
  return user.username !== undefined ? `@${user.username}` : null;
}

/* -------------------------------------------------------------------------- */
/* The mapper                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `message.message_id` is `0` for a message the server has not actually sent
 * yet (large media scheduled for later delivery, per the Bot API docs). The
 * domain's `MessageId` brand rejects `0` outright (DESIGN: ids are validated
 * at the boundary), so there is nothing valid to store — the caller treats a
 * `null` return as "no content".
 */
export function mapTelegramMessageToStoredMessage(
  message: TelegramMessage,
  chatId: ChatId,
): StoredMessage | null {
  if (message.message_id === 0) return null;

  const kind = detectMessageKind(message);
  const rawText = textOrCaptionOf(message, kind);
  const redaction = rawText === null ? null : redactSecrets(rawText);
  const finalKind: MessageKind = redaction?.wholeBodyRedacted === true ? 'redacted' : kind;
  const finalText = redaction === null ? null : redaction.wholeBodyRedacted ? REDACTED_PLACEHOLDER : redaction.text;

  const replyTo = message.reply_to_message;
  const replyToMessageId =
    replyTo !== undefined && replyTo.message_id !== 0 ? asMessageId(replyTo.message_id) : null;

  return {
    chatId,
    messageId: asMessageId(message.message_id),
    threadId: message.is_topic_message === true ? asOptionalThreadId(message.message_thread_id) : null,
    userId: message.from !== undefined ? asUserId(message.from.id) : null,
    displayName: displayNameOf(message),
    ts: Temporal.Instant.fromEpochMilliseconds(message.date * 1000),
    replyToMessageId,
    kind: finalKind,
    text: finalText,
  };
}

/* -------------------------------------------------------------------------- */
/* Update classification                                                      */
/* -------------------------------------------------------------------------- */

export interface ExtractedMessageUpdate {
  readonly message: TelegramMessage;
  /** True for `edited_message`: update in place (DESIGN §4). */
  readonly isEdit: boolean;
}

/**
 * Pulls the `message`/`edited_message` payload out of an `Update`, or `null`
 * for every other update kind (`callback_query`, `my_chat_member`, …) — those
 * are not this workstream's concern (WS6, WS12).
 */
export function extractIncomingMessage(update: Update): ExtractedMessageUpdate | null {
  if (update.message !== undefined) return { message: update.message, isEdit: false };
  if (update.edited_message !== undefined) return { message: update.edited_message, isEdit: true };
  return null;
}

/**
 * DESIGN §6.4 excludes only *this bot's own* messages from the corpus. A
 * message from some *other* bot account is a judgment call this workstream
 * makes the same way: a second bot's chatter is not a human utterance either,
 * and letting it into the corpus risks the same poisoning DESIGN §6.4 warns
 * about for our own output — just from a different source.
 *
 * This can only be decided here, from the raw `from.is_bot` flag: `StoredMessage`
 * deliberately carries no such field (DESIGN §3, no grammY type downstream), so
 * the check has to happen before the mapping boundary is crossed.
 */
export function isFromOtherBot(message: TelegramMessage, botUserId: UserId): boolean {
  const from = message.from;
  return from !== undefined && from.is_bot && from.id !== botUserId;
}

/* -------------------------------------------------------------------------- */
/* Chat membership (join announcement, DESIGN §5)                             */
/* -------------------------------------------------------------------------- */

const ACTIVE_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

export interface BotJoinedChat {
  readonly chatId: ChatId;
}

/**
 * `null` unless this `my_chat_member` update is *this bot* transitioning from
 * not-in-the-chat to in-the-chat — the moment the join announcement (DESIGN
 * §5) and the allowlist decision both fire.
 */
export function extractBotJoin(update: Update, botUserId: UserId): BotJoinedChat | null {
  const change = update.my_chat_member;
  if (change === undefined) return null;
  if (change.new_chat_member.user.id !== botUserId) return null;
  const wasActive = ACTIVE_MEMBER_STATUSES.has(change.old_chat_member.status);
  const isActive = ACTIVE_MEMBER_STATUSES.has(change.new_chat_member.status);
  if (wasActive || !isActive) return null;
  return { chatId: asChatId(change.chat.id) };
}
