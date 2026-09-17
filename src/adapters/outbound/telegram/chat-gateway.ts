/**
 * `ChatGateway` via grammY (DESIGN §3, §8).
 *
 * No grammY type crosses this file's exports — everything is `TelegramApiClientLike`,
 * `SendTextParams`/`SentMessage`/... (the port's own vocabulary), and the
 * typed errors from `src/domain/errors.ts`. `map.ts` (WS2) is the mirror of
 * this file on the inbound side; this is the outbound half of "no grammY
 * type crosses into application or domain" (DESIGN §3).
 *
 * DESIGN §6.5: link previews are off on every send/edit — not a per-call
 * knob, always `link_preview_options.is_disabled = true`. `parse_mode` is
 * always `'HTML'`; the *text* itself is expected to already be rendered and
 * escaped by `src/domain/render` (DESIGN §6.5, `SendTextParams.text` doc:
 * "the gateway does not render, ever").
 */
import { DmForbiddenError, TelegramApiError, TelegramRateLimitedError } from '../../../domain/errors.js';
import { asChatId, asMessageId, asOptionalThreadId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId, MessageId, ThreadId, UserId } from '../../../domain/model/ids.js';
import type { ChatMemberStatus } from '../../../domain/model/tier.js';
import type {
  BotIdentity,
  ChatGateway,
  EditTextParams,
  InlineKeyboard,
  SendTextParams,
  SentMessage,
} from '../../../application/ports/driven/chat-gateway.js';
import { defaultTelegramApiClientFactory } from './api-client.js';
import type { RawInlineKeyboardMarkup, TelegramApiClientFactory, TelegramApiClientLike } from './api-client.js';

/** DESIGN §8: link previews off is not a knob — it is always this. */
const LINK_PREVIEW_OFF = { is_disabled: true as const };

const KNOWN_MEMBER_STATUSES: readonly ChatMemberStatus[] = [
  'creator',
  'administrator',
  'member',
  'restricted',
  'left',
  'kicked',
];

function mapChatMemberStatus(status: string): ChatMemberStatus {
  // An unrecognised status (a future Telegram addition) falls back to the
  // least-privileged tier rather than risking an unintended grant.
  return (KNOWN_MEMBER_STATUSES as readonly string[]).includes(status)
    ? (status as ChatMemberStatus)
    : 'member';
}

function toKeyboardMarkup(keyboard: InlineKeyboard | null | undefined): RawInlineKeyboardMarkup | undefined {
  if (keyboard === null || keyboard === undefined) return undefined;
  return {
    inline_keyboard: keyboard.rows.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/** Structural shape of a Telegram Bot API error, whether it arrives as a real `GrammyError` or a test double. */
interface TelegramApiErrorLike {
  readonly error_code: number;
  readonly parameters?: { readonly retry_after?: number };
}

function isTelegramApiErrorLike(error: unknown): error is TelegramApiErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error_code' in error &&
    typeof (error as { error_code: unknown }).error_code === 'number'
  );
}

/**
 * Maps whatever the client throws to a typed domain error.
 *
 * `treatForbiddenAsDm` is set only by `sendDirect` (DESIGN §1: a `403` there
 * specifically means "this user never `/start`ed the bot" — the same status
 * code from any other method is an ordinary unexpected API error).
 */
function toDomainError(error: unknown, method: string, options: { treatForbiddenAsDm?: boolean } = {}): Error {
  if (isTelegramApiErrorLike(error)) {
    if (error.error_code === 429) {
      // DESIGN §8: "retry_after is authoritative — sleep exactly that
      // long." A missing value (should not happen for a real 429, but a
      // hostile or malformed response is not impossible) falls back to 1s
      // rather than 0, which would mean "retry immediately".
      const retryAfter = error.parameters?.retry_after ?? 1;
      return new TelegramRateLimitedError(retryAfter, { cause: error });
    }
    if (error.error_code === 403 && options.treatForbiddenAsDm === true) {
      return new DmForbiddenError({ cause: error });
    }
    return new TelegramApiError(error.error_code, method, { cause: error });
  }
  return new TelegramApiError(null, method, { cause: error });
}

export interface TelegramChatGatewayOptions {
  readonly token: string;
  readonly clientFactory?: TelegramApiClientFactory;
}

export class TelegramChatGateway implements ChatGateway {
  readonly #client: TelegramApiClientLike;

  constructor(options: TelegramChatGatewayOptions) {
    this.#client = (options.clientFactory ?? defaultTelegramApiClientFactory)(options.token);
  }

  async sendText(chatId: ChatId, params: SendTextParams): Promise<SentMessage> {
    try {
      const sent = await this.#client.sendMessage(chatId, params.text, {
        parse_mode: 'HTML',
        link_preview_options: LINK_PREVIEW_OFF,
        message_thread_id: params.threadId ?? undefined,
        reply_to_message_id: params.replyToMessageId ?? undefined,
        reply_markup: toKeyboardMarkup(params.keyboard),
        disable_notification: params.silent,
      });
      return {
        chatId,
        messageId: asMessageId(sent.message_id),
        threadId: asOptionalThreadId(sent.message_thread_id ?? params.threadId ?? null),
      };
    } catch (error) {
      throw toDomainError(error, 'sendMessage');
    }
  }

  async editText(chatId: ChatId, messageId: MessageId, params: EditTextParams): Promise<void> {
    try {
      await this.#client.editMessageText(chatId, messageId, params.text, {
        parse_mode: 'HTML',
        link_preview_options: LINK_PREVIEW_OFF,
        reply_markup: toKeyboardMarkup(params.keyboard),
      });
    } catch (error) {
      throw toDomainError(error, 'editMessageText');
    }
  }

  async deleteMessage(chatId: ChatId, messageId: MessageId): Promise<void> {
    try {
      await this.#client.deleteMessage(chatId, messageId);
    } catch (error) {
      throw toDomainError(error, 'deleteMessage');
    }
  }

  async sendDirect(userId: UserId, params: Omit<SendTextParams, 'threadId'>): Promise<SentMessage> {
    try {
      // DESIGN §1: "A private chat's id *is* the user id" — this is the one
      // method with no `chatId` for exactly that reason (port doc).
      const sent = await this.#client.sendMessage(userId, params.text, {
        parse_mode: 'HTML',
        link_preview_options: LINK_PREVIEW_OFF,
        reply_to_message_id: params.replyToMessageId ?? undefined,
        reply_markup: toKeyboardMarkup(params.keyboard),
        disable_notification: params.silent,
      });
      return { chatId: asChatId(userId), messageId: asMessageId(sent.message_id), threadId: null };
    } catch (error) {
      throw toDomainError(error, 'sendMessage', { treatForbiddenAsDm: true });
    }
  }

  async getMemberStatus(chatId: ChatId, userId: UserId): Promise<ChatMemberStatus> {
    try {
      const member = await this.#client.getChatMember(chatId, userId);
      return mapChatMemberStatus(member.status);
    } catch (error) {
      throw toDomainError(error, 'getChatMember');
    }
  }

  async leaveChat(chatId: ChatId): Promise<void> {
    try {
      await this.#client.leaveChat(chatId);
    } catch (error) {
      throw toDomainError(error, 'leaveChat');
    }
  }

  async sendTyping(chatId: ChatId, threadId: ThreadId | null): Promise<void> {
    try {
      await this.#client.sendChatAction(chatId, threadId ?? undefined);
    } catch (error) {
      throw toDomainError(error, 'sendChatAction');
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.#client.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      throw toDomainError(error, 'answerCallbackQuery');
    }
  }

  async getMe(): Promise<BotIdentity> {
    try {
      const me = await this.#client.getMe();
      return { userId: asUserId(me.id), username: me.username ?? '' };
    } catch (error) {
      throw toDomainError(error, 'getMe');
    }
  }
}
