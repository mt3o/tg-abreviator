/** In-memory `OptOutStore` — `opt_outs`. */
import type { ChatId, UserId } from '../../src/domain/model/ids.js';
import type { OptOutStore } from '../../src/application/ports/driven/opt-out-store.js';

export class FakeOptOutStore implements OptOutStore {
  readonly #rows = new Map<ChatId, Set<UserId>>();

  async isOptedOut(chatId: ChatId, userId: UserId): Promise<boolean> {
    return await Promise.resolve(this.#chat(chatId).has(userId));
  }

  async listOptedOut(chatId: ChatId): Promise<readonly UserId[]> {
    return await Promise.resolve([...this.#chat(chatId)].sort((a, b) => a - b));
  }

  async optOut(chatId: ChatId, userId: UserId): Promise<void> {
    this.#chat(chatId).add(userId);
    await Promise.resolve();
  }

  async optIn(chatId: ChatId, userId: UserId): Promise<void> {
    this.#chat(chatId).delete(userId);
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    this.#rows.delete(chatId);
    await Promise.resolve();
  }

  knownChatIds(): readonly ChatId[] {
    return [...this.#rows.keys()];
  }

  #chat(chatId: ChatId): Set<UserId> {
    let chat = this.#rows.get(chatId);
    if (chat === undefined) {
      chat = new Set<UserId>();
      this.#rows.set(chatId, chat);
    }
    return chat;
  }
}
