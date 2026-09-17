/**
 * `ChatGateway` — send / edit / getMember / leave / typing / answerCallback
 * (DESIGN §3).
 *
 * The whole point of this port is that **no grammY type crosses it**. A
 * `Message` goes in as `SendTextParams` and comes back as `SentMessage`;
 * `getChatMember` comes back as a domain `ChatMemberStatus`.
 *
 * Failure modes are typed, not numeric: implementations throw
 * `TelegramRateLimitedError` (with `retry_after` — authoritative, sleep exactly
 * that long, DESIGN §8), `DmForbiddenError` (the 403 from a user who never
 * `/start`ed the bot, DESIGN §1) or `TelegramApiError`.
 */
import type { ChatId, MessageId, ThreadId, UserId } from '../../../domain/model/ids.js';
import type { ChatMemberStatus } from '../../../domain/model/tier.js';

/** DESIGN §12: the 👍/👎 keyboard. Callback data is opaque to the gateway. */
export interface InlineButton {
  readonly text: string;
  /** Telegram caps this at 64 bytes. */
  readonly callbackData: string;
}

export interface InlineKeyboard {
  readonly rows: readonly (readonly InlineButton[])[];
}

export interface SendTextParams {
  /**
   * Telegram HTML, already rendered and escaped by the domain (DESIGN §6.5):
   * `<b>`, `<i>`, `<code>` only, everything else escaped, `tg://` stripped,
   * `@` mentions neutralised. The gateway does not render, ever.
   *
   * 1–4096 characters (DESIGN §1). Splitting happens before this call.
   */
  readonly text: string;
  /** Forum topic to post into. Omitting it posts to General (DESIGN §1). */
  readonly threadId: ThreadId | null;
  readonly replyToMessageId?: MessageId | null;
  readonly keyboard?: InlineKeyboard | null;
  /** Link previews are off for every message (DESIGN §6.5); this is not a knob. */
  readonly silent?: boolean;
}

export interface EditTextParams {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | null;
}

export interface SentMessage {
  readonly chatId: ChatId;
  readonly messageId: MessageId;
  readonly threadId: ThreadId | null;
}

export interface BotIdentity {
  readonly userId: UserId;
  readonly username: string;
}

export interface ChatGateway {
  /** DESIGN §8: the placeholder (`⏳ Czytam 430 wiadomości…`) is sent with this. */
  sendText(chatId: ChatId, params: SendTextParams): Promise<SentMessage>;

  /**
   * DESIGN §8: the result arrives by editing the placeholder. Callers throttle
   * to ~1 edit / 3s — edits count against the same 20/min group budget.
   */
  editText(chatId: ChatId, messageId: MessageId, params: EditTextParams): Promise<void>;

  deleteMessage(chatId: ChatId, messageId: MessageId): Promise<void>;

  /**
   * DM delivery for `/tldr dm on` (DESIGN §8). Keyed by user, not by chat, so
   * it is the one method here with no `chatId`: a DM has no group scope.
   * Throws `DmForbiddenError` when the user never `/start`ed the bot; the caller
   * falls back in-chat rather than dropping the answer.
   */
  sendDirect(userId: UserId, params: Omit<SendTextParams, 'threadId'>): Promise<SentMessage>;

  /** Backs the `chatAdmin` tier (DESIGN §2): `creator` / `administrator`. */
  getMemberStatus(chatId: ChatId, userId: UserId): Promise<ChatMemberStatus>;

  /** DESIGN §5: anywhere not on the allowlist — reply, leave, store nothing. */
  leaveChat(chatId: ChatId): Promise<void>;

  /**
   * DESIGN §1: lasts 5 seconds or less, so it is *not* how long operations are
   * covered — that is the placeholder. Kept for short acknowledgements.
   */
  sendTyping(chatId: ChatId, threadId: ThreadId | null): Promise<void>;

  /**
   * DESIGN §12: every 👍/👎 press needs one of these or the client spins.
   * The id is Telegram's opaque callback query id.
   */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;

  /** DESIGN §6.4: the bot's own user id, so its messages can be excluded. */
  getMe(): Promise<BotIdentity>;
}
