/**
 * `TelegramChatGateway` against a hand-written fake `TelegramApiClientLike`
 * — no grammY, no network. Mirrors the pattern WS4 uses for the Anthropic
 * client (`AnthropicClientLike`).
 */
import { describe, expect, it, vi } from 'vitest';

import { DmForbiddenError, TelegramApiError, TelegramRateLimitedError } from '../../../domain/errors.js';
import { asChatId, asMessageId, asThreadId, asUserId } from '../../../domain/model/ids.js';
import type {
  EditMessageTextOptions,
  RawBotUser,
  RawChatMember,
  RawSentMessage,
  SendMessageOptions,
  TelegramApiClientLike,
} from './api-client.js';
import { TelegramChatGateway } from './chat-gateway.js';

interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeFakeClient(overrides: Partial<TelegramApiClientLike> = {}) {
  const calls: FakeCall[] = [];
  const client: TelegramApiClientLike = {
    sendMessage: vi.fn(async (chatId: number, text: string, other: SendMessageOptions) => {
      calls.push({ method: 'sendMessage', args: [chatId, text, other] });
      return { message_id: 555 } satisfies RawSentMessage;
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, other: EditMessageTextOptions) => {
      calls.push({ method: 'editMessageText', args: [chatId, messageId, text, other] });
      return true;
    }),
    deleteMessage: vi.fn(async (chatId: number, messageId: number) => {
      calls.push({ method: 'deleteMessage', args: [chatId, messageId] });
      return true;
    }),
    getChatMember: vi.fn(async (chatId: number, userId: number) => {
      calls.push({ method: 'getChatMember', args: [chatId, userId] });
      return { status: 'administrator' } satisfies RawChatMember;
    }),
    leaveChat: vi.fn(async (chatId: number) => {
      calls.push({ method: 'leaveChat', args: [chatId] });
      return true;
    }),
    sendChatAction: vi.fn(async (chatId: number, threadId: number | undefined) => {
      calls.push({ method: 'sendChatAction', args: [chatId, threadId] });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (callbackQueryId: string, text?: string) => {
      calls.push({ method: 'answerCallbackQuery', args: [callbackQueryId, text] });
      return true;
    }),
    getMe: vi.fn(async () => {
      calls.push({ method: 'getMe', args: [] });
      return { id: 999, username: 'tg_abreviator_test_bot' } satisfies RawBotUser;
    }),
    ...overrides,
  };
  return { client, calls };
}

function gatewayWith(client: TelegramApiClientLike): TelegramChatGateway {
  return new TelegramChatGateway({ token: 'test-token', clientFactory: () => client });
}

const CHAT_ID = asChatId(-1001);
const USER_ID = asUserId(42);

describe('TelegramChatGateway — sendText', () => {
  it('always sets parse_mode HTML and link previews off, whatever the caller asks', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    const sent = await gateway.sendText(CHAT_ID, {
      text: '<b>hi</b>',
      threadId: asThreadId(7),
      replyToMessageId: asMessageId(3),
      silent: true,
    });

    expect(sent).toEqual({ chatId: CHAT_ID, messageId: asMessageId(555), threadId: asThreadId(7) });
    const call = calls[0];
    expect(call?.method).toBe('sendMessage');
    const other = call?.args[2] as SendMessageOptions;
    expect(other.parse_mode).toBe('HTML');
    expect(other.link_preview_options).toEqual({ is_disabled: true });
    expect(other.message_thread_id).toBe(7);
    expect(other.reply_to_message_id).toBe(3);
    expect(other.disable_notification).toBe(true);
  });

  it('posts to General (omits message_thread_id) when threadId is null', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    await gateway.sendText(CHAT_ID, { text: 'hi', threadId: null });

    const other = calls[0]?.args[2] as SendMessageOptions;
    expect(other.message_thread_id).toBeUndefined();
  });

  it('maps an InlineKeyboard to Telegram\'s raw shape', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    await gateway.sendText(CHAT_ID, {
      text: 'hi',
      threadId: null,
      keyboard: { rows: [[{ text: '👍', callbackData: 'up:1' }, { text: '👎', callbackData: 'down:1' }]] },
    });

    const other = calls[0]?.args[2] as SendMessageOptions;
    expect(other.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '👍', callback_data: 'up:1' },
          { text: '👎', callback_data: 'down:1' },
        ],
      ],
    });
  });
});

describe('TelegramChatGateway — editText', () => {
  it('passes chat, message id and text through, HTML and no previews', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    await gateway.editText(CHAT_ID, asMessageId(9), { text: '<i>updated</i>' });

    const call = calls[0];
    expect(call?.method).toBe('editMessageText');
    expect(call?.args[0]).toBe(CHAT_ID);
    expect(call?.args[1]).toBe(9);
    expect(call?.args[2]).toBe('<i>updated</i>');
    const other = call?.args[3] as EditMessageTextOptions;
    expect(other.parse_mode).toBe('HTML');
    expect(other.link_preview_options).toEqual({ is_disabled: true });
  });
});

describe('TelegramChatGateway — sendDirect', () => {
  it('sends to the user id as the chat id, with no thread', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    const sent = await gateway.sendDirect(USER_ID, { text: 'hi' });

    expect(sent).toEqual({ chatId: asChatId(42), messageId: asMessageId(555), threadId: null });
    expect(calls[0]?.args[0]).toBe(42);
  });

  it('maps a 403 to DmForbiddenError — DESIGN §1', async () => {
    const { client } = makeFakeClient({
      sendMessage: vi.fn(async () => {
        throw { error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" };
      }),
    });
    const gateway = gatewayWith(client);

    await expect(gateway.sendDirect(USER_ID, { text: 'hi' })).rejects.toBeInstanceOf(DmForbiddenError);
  });

  it('does NOT map a 403 from sendText (in-chat) to DmForbiddenError', async () => {
    const { client } = makeFakeClient({
      sendMessage: vi.fn(async () => {
        throw { error_code: 403, description: 'Forbidden: bot was kicked' };
      }),
    });
    const gateway = gatewayWith(client);

    await expect(gateway.sendText(CHAT_ID, { text: 'hi', threadId: null })).rejects.toBeInstanceOf(
      TelegramApiError,
    );
  });
});

describe('TelegramChatGateway — error mapping', () => {
  it('maps a 429 to TelegramRateLimitedError carrying the exact retry_after', async () => {
    const { client } = makeFakeClient({
      sendMessage: vi.fn(async () => {
        throw { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } };
      }),
    });
    const gateway = gatewayWith(client);

    const error = await gateway.sendText(CHAT_ID, { text: 'hi', threadId: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramRateLimitedError);
    expect((error as TelegramRateLimitedError).retryAfterSeconds).toBe(17);
  });

  it('maps any other API error to TelegramApiError carrying the status', async () => {
    const { client } = makeFakeClient({
      sendMessage: vi.fn(async () => {
        throw { error_code: 500, description: 'Internal Server Error' };
      }),
    });
    const gateway = gatewayWith(client);

    const error = await gateway.sendText(CHAT_ID, { text: 'hi', threadId: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).httpStatus).toBe(500);
  });

  it('maps a network-level failure (no error_code) to TelegramApiError with a null status', async () => {
    const { client } = makeFakeClient({
      sendMessage: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    });
    const gateway = gatewayWith(client);

    const error = await gateway.sendText(CHAT_ID, { text: 'hi', threadId: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).httpStatus).toBeNull();
  });
});

describe('TelegramChatGateway — getMemberStatus', () => {
  it('passes through a known status', async () => {
    const { client } = makeFakeClient({
      getChatMember: vi.fn(async () => ({ status: 'creator' })),
    });
    const gateway = gatewayWith(client);

    expect(await gateway.getMemberStatus(CHAT_ID, USER_ID)).toBe('creator');
  });

  it('falls back an unrecognised status to member, never a higher tier', async () => {
    const { client } = makeFakeClient({
      getChatMember: vi.fn(async () => ({ status: 'some_future_status' })),
    });
    const gateway = gatewayWith(client);

    expect(await gateway.getMemberStatus(CHAT_ID, USER_ID)).toBe('member');
  });
});

describe('TelegramChatGateway — the rest', () => {
  it('leaveChat, sendTyping, answerCallbackQuery and getMe delegate correctly', async () => {
    const { client, calls } = makeFakeClient();
    const gateway = gatewayWith(client);

    await gateway.leaveChat(CHAT_ID);
    await gateway.sendTyping(CHAT_ID, asThreadId(4));
    await gateway.answerCallbackQuery('cbq-1', 'ok');
    const identity = await gateway.getMe();

    expect(calls.map((c) => c.method)).toEqual([
      'leaveChat',
      'sendChatAction',
      'answerCallbackQuery',
      'getMe',
    ]);
    expect(identity).toEqual({ userId: asUserId(999), username: 'tg_abreviator_test_bot' });
  });
});
