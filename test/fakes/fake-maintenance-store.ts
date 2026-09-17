/**
 * In-memory `MaintenanceStore`.
 *
 * The TTL sweeper needs to know which chats exist, and every deletion method is
 * chat-scoped by construction (DESIGN §6.1). The fake asks its collaborators
 * the same way the SQLite adapter asks the database.
 */
import type { ChatId } from '../../src/domain/model/ids.js';
import type { MaintenanceStore } from '../../src/application/ports/driven/maintenance-store.js';

export interface ChatIdSource {
  knownChatIds(): readonly ChatId[];
}

export class FakeMaintenanceStore implements MaintenanceStore {
  readonly #sources: readonly ChatIdSource[];
  readonly #extra = new Set<ChatId>();

  constructor(...sources: ChatIdSource[]) {
    this.#sources = sources;
  }

  async listChatIds(): Promise<readonly ChatId[]> {
    const ids = new Set<ChatId>(this.#extra);
    for (const source of this.#sources) {
      for (const id of source.knownChatIds()) ids.add(id);
    }
    return await Promise.resolve([...ids].sort((a, b) => a - b));
  }

  /** For tests that want a chat to exist without writing a row first. */
  add(chatId: ChatId): void {
    this.#extra.add(chatId);
  }
}
