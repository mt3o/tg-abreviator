/**
 * `MaintenanceStore` — the chat enumerator the TTL sweeper needs (DESIGN §5).
 *
 * Every deletion method on every store is chat-scoped by construction
 * (DESIGN §6.1), which leaves the sweeper with nothing to iterate over. This
 * port answers exactly that question and nothing else: **ids, never rows**.
 * Keeping it separate means "list every chat" is a deliberate call rather than
 * an omitted argument.
 */
import type { ChatId } from '../../../domain/model/ids.js';

export interface MaintenanceStore {
  /** Every chat with stored data, in no particular order. */
  listChatIds(): Promise<readonly ChatId[]>;
}
