/**
 * `IngestMessage` (DESIGN §3, §4, §5, §6).
 *
 * The only write path into the corpus, and the component whose bugs are
 * unrecoverable: an unlogged message is gone forever (PLAN, M1). Everything it
 * must enforce is a "never" from DESIGN §5 and §6:
 *
 * - not on the allowlist → reply, `leaveChat`, **store nothing**;
 * - opted out → store **nothing at all**, not even a placeholder;
 * - the bot's own messages never enter the corpus;
 * - secret shapes are `[redacted]` before the row is written;
 * - an edit updates the row in place.
 */
import type { StoredMessage } from '../../../domain/model/message.js';
import type { UserId } from '../../../domain/model/ids.js';

export interface IngestMessageCommand {
  /** Already mapped from the Telegram `Update` at the adapter boundary. */
  readonly message: StoredMessage;
  /** True for `edited_message`: update in place (DESIGN §4). */
  readonly isEdit: boolean;
  /** So the bot's own output can never become corpus (DESIGN §6.4). */
  readonly botUserId: UserId;
}

export type IngestSkipReason =
  | 'opted_out'
  | 'own_message'
  | 'other_bot'
  | 'no_content';

export type IngestOutcome =
  | { readonly kind: 'stored' }
  | { readonly kind: 'updated' }
  | { readonly kind: 'skipped'; readonly reason: IngestSkipReason }
  /** Not on the allowlist: replied, left, stored nothing (DESIGN §5). */
  | { readonly kind: 'left_chat' };

export interface IngestMessage {
  execute(command: IngestMessageCommand): Promise<IngestOutcome>;
}
