/**
 * `PurgeChat` — `/forget`, chat-admin tier (DESIGN §2, §3, §5).
 *
 * Wipes the whole chat log: messages, chunks, usage events, user preferences,
 * opt-out rows and pseudonyms — the chat's own label included, so the labels
 * already in the error sink stop resolving (DESIGN §11).
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';

export interface PurgeChatCommand {
  readonly chatId: ChatId;
  readonly requestedBy: UserId;
  readonly at: Temporal.Instant;
}

export interface PurgeChatResult {
  readonly messagesDeleted: number;
  readonly chunksDeleted: number;
  readonly usageRowsDeleted: number;
}

export interface PurgeChat {
  execute(command: PurgeChatCommand): Promise<PurgeChatResult>;
}
