/**
 * Identifiers, branded.
 *
 * DESIGN §6.1 makes "never cross chats" a structural guarantee rather than a
 * remembered rule: `chatId` is the required first parameter of every
 * chat-scoped store method. Branding the identifier types is the other half of
 * that — `store.fetchRange(userId, ...)` does not compile, and neither does
 * passing a `MessageId` where a `ChatId` belongs.
 *
 * Raw numbers enter the system at exactly two kinds of place: the Telegram
 * adapter (mapping an `Update`) and a store adapter (reading a row). Both call
 * the smart constructors below, which validate. Everything downstream carries
 * the branded type.
 */
import { InvalidValueError } from '../errors.js';

declare const brand: unique symbol;

/** Nominal typing helper. `Brand<number, 'ChatId'>` is not assignable to `number`'s other brands. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Telegram chat id. Negative for groups and supergroups, positive for private chats. */
export type ChatId = Brand<number, 'ChatId'>;

/** Telegram user id. Always positive. */
export type UserId = Brand<number, 'UserId'>;

/**
 * Telegram message id, unique per chat.
 *
 * Positive values are real Telegram messages. **Negative values are synthetic
 * rows allocated by the store** — currently only gap markers (DESIGN §4), which
 * are real rows but have no Telegram message behind them. Telegram never issues
 * a non-positive message id, so the two spaces cannot collide.
 */
export type MessageId = Brand<number, 'MessageId'>;

/** Forum topic id (`message_thread_id`). `null` means General / a non-forum chat. */
export type ThreadId = Brand<number, 'ThreadId'>;

/** Opaque id of a `usage_events` row. */
export type UsageEventId = Brand<string, 'UsageEventId'>;

export function asChatId(value: number): ChatId {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new InvalidValueError(`chat id must be a non-zero safe integer, got ${String(value)}`);
  }
  return value as ChatId;
}

export function asUserId(value: number): UserId {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidValueError(`user id must be a positive safe integer, got ${String(value)}`);
  }
  return value as UserId;
}

export function asMessageId(value: number): MessageId {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new InvalidValueError(`message id must be a non-zero safe integer, got ${String(value)}`);
  }
  return value as MessageId;
}

export function asThreadId(value: number): ThreadId {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidValueError(`thread id must be a positive safe integer, got ${String(value)}`);
  }
  return value as ThreadId;
}

export function asUsageEventId(value: string): UsageEventId {
  if (value.length === 0) {
    throw new InvalidValueError('usage event id must not be empty');
  }
  return value as UsageEventId;
}

/** `null` passes through — a missing `message_thread_id` is General, not an error. */
export function asOptionalThreadId(value: number | null | undefined): ThreadId | null {
  return value === null || value === undefined ? null : asThreadId(value);
}

/** Parses a chat id out of a string (config files, env vars, command arguments). */
export function parseChatId(value: string): ChatId {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new InvalidValueError(`chat id is not a number: ${value}`);
  }
  return asChatId(parsed);
}

/** Parses a user id out of a string (`OPERATOR_USER_IDS`, command arguments). */
export function parseUserId(value: string): UserId {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new InvalidValueError(`user id is not a number: ${value}`);
  }
  return asUserId(parsed);
}

/** A synthetic row id is any non-positive message id (DESIGN §4, gap markers). */
export function isSyntheticMessageId(value: MessageId): boolean {
  return value < 0;
}
