/**
 * `PurgeChat` — `/forget`, chat-admin tier (DESIGN §2, §5, §11).
 *
 * Wipes one chat completely: messages, chunks, usage events, chat settings and
 * user preferences, opt-out rows and pseudonyms — the chat's own label
 * included, so the labels already sitting in the error sink stop resolving
 * (DESIGN §11).
 *
 * The opt-out rows go too. `/forget` is "wipe the whole chat log", not "erase
 * these people": a member who asked to be forgotten individually did so through
 * `/forgetme`, whose opt-out row is about *future* storage in a chat that
 * continues to exist. Here the chat's own history is being reset by its admin,
 * and leaving orphaned opt-out rows behind would silently keep members out of
 * every future summary with nothing in the chat to explain why.
 *
 * The derived config cache is invalidated last: the `chat` layer (DESIGN §10,
 * layer 4) is backed by the `chat_settings` row this just deleted, so a cached
 * derivation would keep serving a timezone and model that no longer exist.
 */
import type { ChunkStore } from '../ports/driven/chunk-store.js';
import type { Config } from '../ports/driven/config.js';
import type { MessageStore } from '../ports/driven/message-store.js';
import type { OptOutStore } from '../ports/driven/opt-out-store.js';
import type { PseudonymStore } from '../ports/driven/pseudonym-store.js';
import type { SettingsStore } from '../ports/driven/settings-store.js';
import type { UsageStore } from '../ports/driven/usage-store.js';
import type { PurgeChat, PurgeChatCommand, PurgeChatResult } from '../ports/driving/purge-chat.js';

export interface PurgeChatDeps {
  readonly messages: MessageStore;
  readonly chunks: ChunkStore;
  readonly optOuts: OptOutStore;
  readonly usage: UsageStore;
  readonly settings: SettingsStore;
  readonly pseudonyms: PseudonymStore;
  readonly config: Config;
}

export class PurgeChatUseCase implements PurgeChat {
  readonly #deps: PurgeChatDeps;

  constructor(deps: PurgeChatDeps) {
    this.#deps = deps;
  }

  async execute(command: PurgeChatCommand): Promise<PurgeChatResult> {
    const { chatId } = command;
    const { messages, chunks, optOuts, usage, settings, pseudonyms, config } = this.#deps;

    // Chunks first: they are derived from messages, and a chunk surviving its
    // source rows is exactly the "cached summary outlives the messages it
    // summarizes" failure DESIGN §5 forbids.
    const chunksDeleted = await chunks.deleteChat(chatId);
    const messagesDeleted = await messages.deleteChat(chatId);
    const usageRowsDeleted = await usage.deleteChat(chatId);
    await settings.deleteChat(chatId);
    await optOuts.deleteChat(chatId);
    await pseudonyms.deleteChat(chatId);

    config.invalidateChat(chatId);

    return { messagesDeleted, chunksDeleted, usageRowsDeleted };
  }
}
