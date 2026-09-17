/**
 * Pure `Update` -> `StoredMessage` mapping (DESIGN §3, §4, §6.2).
 *
 * No store, no gateway, no fakes: every function under test here is pure, so
 * every assertion is a direct call-and-check.
 */
import { describe, expect, it } from 'vitest';
import type { Message as TelegramMessage, Update } from 'grammy/types';

import { asUserId } from '../../../../src/domain/model/ids.js';
import {
  detectMessageKind,
  extractBotJoin,
  extractIncomingMessage,
  isFromOtherBot,
  mapTelegramMessageToStoredMessage,
  redactSecrets,
} from '../../../../src/adapters/inbound/telegram/map.js';
import { asChatId } from '../../../../src/domain/model/ids.js';

const BASE: TelegramMessage = {
  message_id: 1,
  date: 1758100000,
  chat: { id: -1009000001, type: 'supergroup', title: 'Deploys' },
  from: { id: 11, is_bot: false, first_name: 'Ala' },
  text: 'hello',
};

describe('detectMessageKind', () => {
  it('reads text messages', () => {
    expect(detectMessageKind(BASE)).toBe('text');
  });

  it('prefers animation over the document it also carries (backward compat field)', () => {
    const msg: TelegramMessage = {
      ...BASE,
      text: undefined,
      document: { file_id: 'd1', file_unique_id: 'du1' },
      animation: { file_id: 'a1', file_unique_id: 'au1', width: 1, height: 1, duration: 1 },
    };
    expect(detectMessageKind(msg)).toBe('animation');
  });

  it('falls back to service for everything else Telegram sends as a message', () => {
    const msg: TelegramMessage = {
      ...BASE,
      text: undefined,
      new_chat_members: [{ id: 44, is_bot: false, first_name: 'Nowy' }],
    };
    expect(detectMessageKind(msg)).toBe('service');
  });
});

describe('mapTelegramMessageToStoredMessage', () => {
  const chatId = asChatId(-1009000001);

  it('maps a plain text message', () => {
    const stored = mapTelegramMessageToStoredMessage(BASE, chatId);
    expect(stored).not.toBeNull();
    expect(stored?.chatId).toBe(chatId);
    expect(stored?.messageId).toBe(1);
    expect(stored?.threadId).toBeNull();
    expect(stored?.userId).toBe(11);
    expect(stored?.displayName).toBe('Ala');
    expect(stored?.kind).toBe('text');
    expect(stored?.text).toBe('hello');
    expect(stored?.ts.epochMilliseconds).toBe(1758100000_000);
  });

  it('scopes to the forum thread only when is_topic_message is set', () => {
    const inTopic = mapTelegramMessageToStoredMessage(
      { ...BASE, message_thread_id: 7, is_topic_message: true },
      chatId,
    );
    expect(inTopic?.threadId).toBe(7);

    // message_thread_id can be present without is_topic_message (e.g. a reply
    // inside a forum's General topic uses it for other purposes) — must not
    // be mistaken for a real topic scope.
    const notATopic = mapTelegramMessageToStoredMessage({ ...BASE, message_thread_id: 7 }, chatId);
    expect(notATopic?.threadId).toBeNull();
  });

  it('maps a caption-carrying media message, storing the caption and a kind placeholder, never the file', () => {
    const msg: TelegramMessage = {
      ...BASE,
      text: undefined,
      photo: [{ file_id: 'AgAD1', file_unique_id: 'u1', width: 90, height: 90 }],
      caption: 'zrzut ekranu',
    };
    const stored = mapTelegramMessageToStoredMessage(msg, chatId);
    expect(stored?.kind).toBe('photo');
    expect(stored?.text).toBe('zrzut ekranu');
    expect(JSON.stringify(stored)).not.toContain('AgAD1');
  });

  it('resolves a reply anchor to the domain MessageId', () => {
    const msg: TelegramMessage = {
      ...BASE,
      message_id: 5,
      reply_to_message: { ...BASE, message_id: 2 } as TelegramMessage['reply_to_message'],
    };
    const stored = mapTelegramMessageToStoredMessage(msg, chatId);
    expect(stored?.replyToMessageId).toBe(2);
  });

  it('falls back to a username when no first/last name is present', () => {
    const msg: TelegramMessage = { ...BASE, from: { id: 12, is_bot: false, first_name: '', username: 'ghost' } };
    const stored = mapTelegramMessageToStoredMessage(msg, chatId);
    expect(stored?.displayName).toBe('@ghost');
  });

  it('returns null for a message_id of 0 (Telegram\'s own "not usable yet" marker)', () => {
    const msg: TelegramMessage = { ...BASE, message_id: 0, video: { file_id: 'v', file_unique_id: 'vu', width: 1, height: 1, duration: 1 } };
    expect(mapTelegramMessageToStoredMessage(msg, chatId)).toBeNull();
  });

  it('redacts a secret embedded in otherwise ordinary text, keeping the kind as text', () => {
    const msg: TelegramMessage = {
      ...BASE,
      text: 'tu jest klucz sk-ant-api03verylongsecretvalue1234567890, nie wrzucajcie do repo',
    };
    const stored = mapTelegramMessageToStoredMessage(msg, chatId);
    expect(stored?.kind).toBe('text');
    expect(stored?.text).toContain('[redacted]');
    expect(stored?.text).not.toContain('sk-ant-api03');
  });

  it('marks the row kind "redacted" when the entire body is one secret', () => {
    const msg: TelegramMessage = { ...BASE, text: 'sk-ant-api03verylongsecretvalue1234567890' };
    const stored = mapTelegramMessageToStoredMessage(msg, chatId);
    expect(stored?.kind).toBe('redacted');
    expect(stored?.text).toBe('[redacted]');
  });
});

describe('redactSecrets', () => {
  it('redacts an IBAN', () => {
    const result = redactSecrets('wpłać na PL61109010140000071219812874 dzięki');
    expect(result.text).toContain('[redacted]');
    expect(result.text).not.toContain('PL61109010140000071219812874');
  });

  it('redacts a spaced card number', () => {
    const result = redactSecrets('karta: 4111 1111 1111 1111');
    expect(result.text).toBe('karta: [redacted]');
  });

  it('redacts a long run of digits', () => {
    const result = redactSecrets('numer konta 123456789012');
    expect(result.text).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const result = redactSecrets('jutro o 15 idziemy na kawę');
    expect(result.text).toBe('jutro o 15 idziemy na kawę');
    expect(result.wholeBodyRedacted).toBe(false);
  });

  it('does not flag a short number as a secret (a time, a small count)', () => {
    const result = redactSecrets('spotkanie o 1500');
    expect(result.text).toBe('spotkanie o 1500');
  });
});

describe('extractIncomingMessage', () => {
  it('reads a message update as a non-edit', () => {
    const update: Update = { update_id: 1, message: BASE as Update['message'] };
    expect(extractIncomingMessage(update)).toEqual({ message: BASE, isEdit: false });
  });

  it('reads an edited_message update as an edit', () => {
    const update: Update = {
      update_id: 1,
      edited_message: { ...BASE, edit_date: 1758100100 } as Update['edited_message'],
    };
    const extracted = extractIncomingMessage(update);
    expect(extracted?.isEdit).toBe(true);
  });

  it('ignores every other update kind', () => {
    const update: Update = {
      update_id: 1,
      poll: {
        id: 'p1',
        question: 'x',
        options: [],
        total_voter_count: 0,
        is_closed: false,
        is_anonymous: true,
        type: 'regular',
        allows_multiple_answers: false,
        allows_revoting: false,
        members_only: false,
      },
    };
    expect(extractIncomingMessage(update)).toBeNull();
  });
});

describe('isFromOtherBot', () => {
  const botUserId = asUserId(999000001);

  it('is false for a human sender', () => {
    expect(isFromOtherBot(BASE, botUserId)).toBe(false);
  });

  it('is false for this bot\'s own messages', () => {
    const msg: TelegramMessage = { ...BASE, from: { id: 999000001, is_bot: true, first_name: 'tg_abreviator' } };
    expect(isFromOtherBot(msg, botUserId)).toBe(false);
  });

  it('is true for a different bot account', () => {
    const msg: TelegramMessage = { ...BASE, from: { id: 777001, is_bot: true, first_name: 'WeatherBot' } };
    expect(isFromOtherBot(msg, botUserId)).toBe(true);
  });
});

describe('extractBotJoin', () => {
  const botUserId = asUserId(999000001);
  const botUser = { id: 999000001, is_bot: true, first_name: 'tg_abreviator' } as const;

  it('detects the bot transitioning from left to member', () => {
    const update: Update = {
      update_id: 1,
      my_chat_member: {
        chat: { id: -1009000001, type: 'supergroup', title: 'Deploys' },
        from: { id: 11, is_bot: false, first_name: 'Ala' },
        date: 1758099900,
        old_chat_member: { status: 'left', user: botUser },
        new_chat_member: { status: 'member', user: botUser },
      },
    };
    expect(extractBotJoin(update, botUserId)).toEqual({ chatId: -1009000001 });
  });

  it('ignores a member-to-member no-op update (e.g. an admin right changed)', () => {
    const update: Update = {
      update_id: 1,
      my_chat_member: {
        chat: { id: -1009000001, type: 'supergroup', title: 'Deploys' },
        from: { id: 11, is_bot: false, first_name: 'Ala' },
        date: 1758099900,
        old_chat_member: { status: 'member', user: botUser },
        new_chat_member: {
          status: 'administrator',
          user: botUser,
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: true,
          can_manage_video_chats: true,
          can_restrict_members: true,
          can_promote_members: false,
          can_change_info: true,
          can_invite_users: true,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_send_welcome_messages: false,
        },
      },
    };
    expect(extractBotJoin(update, botUserId)).toBeNull();
  });

  it('ignores a chat-member update about someone else', () => {
    const update: Update = {
      update_id: 1,
      my_chat_member: {
        chat: { id: -1009000001, type: 'supergroup', title: 'Deploys' },
        from: { id: 11, is_bot: false, first_name: 'Ala' },
        date: 1758099900,
        old_chat_member: { status: 'left', user: { id: 44, is_bot: false, first_name: 'Ktoś' } },
        new_chat_member: { status: 'member', user: { id: 44, is_bot: false, first_name: 'Ktoś' } },
      },
    };
    expect(extractBotJoin(update, botUserId)).toBeNull();
  });
});
