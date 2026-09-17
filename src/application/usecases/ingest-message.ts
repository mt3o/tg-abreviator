/**
 * `IngestMessage` (DESIGN §3, §4, §5, §6) — the only write path into the
 * corpus, and the one whose bugs are unrecoverable: an unlogged message is
 * gone forever (PLAN, M1).
 *
 * Every branch here is a "never" from DESIGN turned into code:
 *
 * - not on the allowlist -> reply "not authorised", `leaveChat`, **nothing
 *   stored** (DESIGN §5);
 * - opted out -> **nothing stored at all**, not even a placeholder (DESIGN §5);
 * - the bot's own messages, and any other bot's, never enter the corpus
 *   (DESIGN §6.4);
 * - an edit updates the row in place (DESIGN §4) — the store's `upsert` is
 *   already idempotent on `(chat_id, message_id)`, so this use case does not
 *   need to distinguish "new" from "replay" itself.
 */
import type { ChatGateway } from '../ports/driven/chat-gateway.js';
import type { Config } from '../ports/driven/config.js';
import type { MessageStore } from '../ports/driven/message-store.js';
import type { OptOutStore } from '../ports/driven/opt-out-store.js';
import type {
  IngestMessage,
  IngestMessageCommand,
  IngestOutcome,
} from '../ports/driving/ingest-message.js';

export interface IngestMessageDeps {
  readonly messages: MessageStore;
  readonly optOuts: OptOutStore;
  readonly config: Config;
  readonly gateway: ChatGateway;
}

/**
 * `IngestMessageCommand` is a frozen Phase 0 contract and carries nothing
 * about the Telegram-specific "is this sender a *different* bot" question —
 * deliberately, since no grammY type may reach `application` (DESIGN §3).
 *
 * `poller.ts` (this workstream's own adapter) decides that question from the
 * raw `Update` and hands the answer across the port boundary as this one
 * extra, optional, plain-boolean field. Any other caller — a test constructing
 * a bare `IngestMessageCommand` — simply omits it and gets `own_message` /
 * ordinary-human handling, which is the correct default.
 */
export interface IngestMessageCommandExt extends IngestMessageCommand {
  readonly senderIsOtherBot?: boolean;
}

const NOT_AUTHORISED_TEXT: Readonly<Record<'pl' | 'en', string>> = {
  pl: 'Ten czat nie jest autoryzowany do korzystania z tego bota. Nic nie zostało zapisane — opuszczam czat.',
  en: 'This chat is not authorised to use this bot. Nothing was stored — leaving the chat.',
};

export class IngestMessageUseCase implements IngestMessage {
  readonly #deps: IngestMessageDeps;

  constructor(deps: IngestMessageDeps) {
    this.#deps = deps;
  }

  async execute(command: IngestMessageCommand): Promise<IngestOutcome> {
    const { message, isEdit } = command;
    const { messages, optOuts, config, gateway } = this.#deps;
    const chatId = message.chatId;

    // DESIGN §5: the single biggest risk reducer. Checked before anything
    // else, and unconditionally — even a reply to the bot's own past message
    // in a chat that fell off the allowlist must not be stored.
    const allowlist = config.get('telegram').allowlist;
    if (!allowlist.includes(chatId)) {
      const language = config.get('bot').language;
      await gateway.sendText(chatId, {
        text: NOT_AUTHORISED_TEXT[language],
        threadId: message.threadId,
      });
      await gateway.leaveChat(chatId);
      return { kind: 'left_chat' };
    }

    // DESIGN §6.4: the bot's own output can never become corpus.
    if (message.userId !== null && message.userId === command.botUserId) {
      return { kind: 'skipped', reason: 'own_message' };
    }

    // See `IngestMessageCommandExt` above: decided by the adapter, from data
    // that never crosses into a `StoredMessage`.
    if ((command as IngestMessageCommandExt).senderIsOtherBot === true) {
      return { kind: 'skipped', reason: 'other_bot' };
    }

    // DESIGN §5: opted-out users are stored as nothing at all, not even a
    // placeholder — checked at ingest *and* filtered again at query time
    // (DESIGN §6.3) for whatever predates the opt-out.
    if (message.userId !== null && (await optOuts.isOptedOut(chatId, message.userId))) {
      return { kind: 'skipped', reason: 'opted_out' };
    }

    // Defensive: a text-kind row with nothing in it carries nothing worth a
    // durable row. Every other kind's content *is* the kind itself (a photo
    // placeholder, a sticker, …), so this never fires for them.
    if (message.kind === 'text' && (message.text === null || message.text.trim().length === 0)) {
      return { kind: 'skipped', reason: 'no_content' };
    }

    await messages.upsert(chatId, message);
    return isEdit ? { kind: 'updated' } : { kind: 'stored' };
  }
}
