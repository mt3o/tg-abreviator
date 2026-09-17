/**
 * The grammY `Api` client, behind the narrowest interface this adapter
 * actually uses — the same pattern WS4 uses for the Anthropic SDK
 * (`src/adapters/outbound/anthropic/client.ts`): this file is the one place
 * that knows a real grammY `Api` exists, and `chat-gateway.ts` only ever
 * sees `TelegramApiClientLike`, which is plain structural TypeScript with no
 * grammY import at all. That makes the gateway testable with a hand-written
 * fake client, no network and no grammY types leaking into its tests.
 */
import { Api } from 'grammy';
import { apiThrottler } from '@grammyjs/transformer-throttler';

/**
 * Structural subset of Telegram's `InlineKeyboardMarkup` (button text +
 * callback data only). Not `readonly` — grammY's own `InlineKeyboardMarkup`
 * type isn't either, and `defaultTelegramApiClientFactory` passes this
 * straight through to it.
 */
export interface RawInlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface SendMessageOptions {
  readonly message_thread_id?: number;
  readonly reply_to_message_id?: number;
  readonly reply_markup?: RawInlineKeyboardMarkup;
  readonly parse_mode: 'HTML';
  /** DESIGN §6.5: link previews off for every message — not a per-call knob. */
  readonly link_preview_options: { readonly is_disabled: true };
  readonly disable_notification?: boolean;
}

export interface EditMessageTextOptions {
  readonly reply_markup?: RawInlineKeyboardMarkup;
  readonly parse_mode: 'HTML';
  readonly link_preview_options: { readonly is_disabled: true };
}

export interface RawSentMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
}

export interface RawChatMember {
  readonly status: string;
}

export interface RawBotUser {
  readonly id: number;
  readonly username?: string;
}

/**
 * The one-method-per-`ChatGateway`-need surface of `Api`. Every method here
 * mirrors the convenience signature grammY's `Api` class already exposes
 * (`chat_id`/`text`/... pulled into positional parameters, the rest in
 * `other`), so `defaultTelegramApiClientFactory` below is a direct pass-through.
 */
export interface TelegramApiClientLike {
  sendMessage(
    chatId: number,
    text: string,
    other: SendMessageOptions,
  ): Promise<RawSentMessage>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other: EditMessageTextOptions,
  ): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  getChatMember(chatId: number, userId: number): Promise<RawChatMember>;
  leaveChat(chatId: number): Promise<unknown>;
  sendChatAction(chatId: number, threadId: number | undefined): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown>;
  getMe(): Promise<RawBotUser>;
}

export type TelegramApiClientFactory = (token: string) => TelegramApiClientLike;

/**
 * DESIGN §8: "grammY's throttler/transformer plugin" — installed as a
 * transformer on the raw API, so every outbound call is paced against
 * Telegram's own limits (~1 msg/s per chat, ~20/min per group, ~30/s global,
 * DESIGN §1) *before* a `429` happens, not just after. Genuine `429`s that
 * still occur (a burst from another process, a fresh restart) are mapped by
 * `chat-gateway.ts` to `TelegramRateLimitedError` with the exact
 * `retry_after` Telegram reported — the throttler reduces how often that
 * happens, it does not replace the typed error path.
 */
export const defaultTelegramApiClientFactory: TelegramApiClientFactory = (token) => {
  const api = new Api(token);
  api.config.use(apiThrottler());

  return {
    sendMessage: (chatId, text, other) => api.sendMessage(chatId, text, other),
    editMessageText: (chatId, messageId, text, other) =>
      api.editMessageText(chatId, messageId, text, other),
    deleteMessage: (chatId, messageId) => api.deleteMessage(chatId, messageId),
    getChatMember: (chatId, userId) => api.getChatMember(chatId, userId),
    leaveChat: (chatId) => api.leaveChat(chatId),
    sendChatAction: (chatId, threadId) =>
      api.sendChatAction(chatId, 'typing', threadId === undefined ? {} : { message_thread_id: threadId }),
    answerCallbackQuery: (callbackQueryId, text) =>
      api.answerCallbackQuery(callbackQueryId, text === undefined ? {} : { text }),
    getMe: () => api.getMe(),
  };
};
