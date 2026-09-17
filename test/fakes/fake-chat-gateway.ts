/**
 * In-memory `ChatGateway`.
 *
 * Records what was sent rather than pretending to be Telegram, and lets a test
 * arm the three failures that actually shape the delivery code (DESIGN §8):
 * a 429 with `retry_after`, a 403 on a DM attempt, and an unexpected API error.
 */
import { DmForbiddenError, TelegramApiError, TelegramRateLimitedError } from '../../src/domain/errors.js';
import { asChatId, asMessageId, asUserId } from '../../src/domain/model/ids.js';
import type { ChatId, MessageId, ThreadId, UserId } from '../../src/domain/model/ids.js';
import type { ChatMemberStatus } from '../../src/domain/model/tier.js';
import type {
  BotIdentity,
  ChatGateway,
  EditTextParams,
  SendTextParams,
  SentMessage,
} from '../../src/application/ports/driven/chat-gateway.js';

export interface SentRecord {
  readonly chatId: ChatId;
  readonly messageId: MessageId;
  readonly params: SendTextParams;
}

export interface EditRecord {
  readonly chatId: ChatId;
  readonly messageId: MessageId;
  readonly params: EditTextParams;
}

export interface DirectRecord {
  readonly userId: UserId;
  readonly params: Omit<SendTextParams, 'threadId'>;
}

export interface FakeChatGatewayOptions {
  readonly identity?: BotIdentity;
}

export class FakeChatGateway implements ChatGateway {
  readonly sent: SentRecord[] = [];
  readonly edits: EditRecord[] = [];
  readonly directs: DirectRecord[] = [];
  readonly deleted: { chatId: ChatId; messageId: MessageId }[] = [];
  readonly typing: { chatId: ChatId; threadId: ThreadId | null }[] = [];
  readonly answeredCallbacks: string[] = [];
  readonly leftChats: ChatId[] = [];

  /** `getMemberStatus` answers from here; anything absent is a plain `member`. */
  readonly memberStatuses = new Map<string, ChatMemberStatus>();
  /** Users who never `/start`ed the bot: `sendDirect` throws `DmForbiddenError`. */
  readonly dmForbidden = new Set<UserId>();

  /** Armed once, consumed by the next `sendText`/`editText`. */
  nextSendFailure: 'rate_limited' | 'api_error' | null = null;
  rateLimitRetryAfterSeconds = 3;

  #nextMessageId = 1000;
  readonly #identity: BotIdentity;

  constructor(options: FakeChatGatewayOptions = {}) {
    this.#identity = options.identity ?? {
      userId: asUserId(999_000_001),
      username: 'tg_abreviator_test_bot',
    };
  }

  async sendText(chatId: ChatId, params: SendTextParams): Promise<SentMessage> {
    this.#maybeFail('sendMessage');
    this.#nextMessageId += 1;
    const messageId = asMessageId(this.#nextMessageId);
    this.sent.push({ chatId, messageId, params });
    return await Promise.resolve({ chatId, messageId, threadId: params.threadId });
  }

  async editText(
    chatId: ChatId,
    messageId: MessageId,
    params: EditTextParams,
  ): Promise<void> {
    this.#maybeFail('editMessageText');
    this.edits.push({ chatId, messageId, params });
    await Promise.resolve();
  }

  async deleteMessage(chatId: ChatId, messageId: MessageId): Promise<void> {
    this.deleted.push({ chatId, messageId });
    await Promise.resolve();
  }

  async sendDirect(
    userId: UserId,
    params: Omit<SendTextParams, 'threadId'>,
  ): Promise<SentMessage> {
    if (this.dmForbidden.has(userId)) throw new DmForbiddenError();
    this.#nextMessageId += 1;
    const messageId = asMessageId(this.#nextMessageId);
    this.directs.push({ userId, params });
    // A private chat's id *is* the user id, which is why a DM needs no chat scope.
    return await Promise.resolve({ chatId: asChatId(userId), messageId, threadId: null });
  }

  async getMemberStatus(chatId: ChatId, userId: UserId): Promise<ChatMemberStatus> {
    const key = `${String(chatId)}:${String(userId)}`;
    return await Promise.resolve(this.memberStatuses.get(key) ?? 'member');
  }

  async leaveChat(chatId: ChatId): Promise<void> {
    this.leftChats.push(chatId);
    await Promise.resolve();
  }

  async sendTyping(chatId: ChatId, threadId: ThreadId | null): Promise<void> {
    this.typing.push({ chatId, threadId });
    await Promise.resolve();
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answeredCallbacks.push(callbackQueryId);
    await Promise.resolve();
  }

  async getMe(): Promise<BotIdentity> {
    return await Promise.resolve(this.#identity);
  }

  /* ---------------------------- test helpers ----------------------------- */

  setMemberStatus(chatId: ChatId, userId: UserId, status: ChatMemberStatus): void {
    this.memberStatuses.set(`${String(chatId)}:${String(userId)}`, status);
  }

  /** Text of everything sent to a chat, in order. */
  textsFor(chatId: ChatId): readonly string[] {
    return this.sent.filter((record) => record.chatId === chatId).map((r) => r.params.text);
  }

  #maybeFail(method: string): void {
    const failure = this.nextSendFailure;
    this.nextSendFailure = null;
    if (failure === 'rate_limited') {
      throw new TelegramRateLimitedError(this.rateLimitRetryAfterSeconds);
    }
    if (failure === 'api_error') throw new TelegramApiError(500, method);
  }
}
