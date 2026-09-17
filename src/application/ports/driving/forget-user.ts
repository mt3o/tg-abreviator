/**
 * `ForgetUser` — `/forgetme` (DESIGN §3, §5, §11).
 *
 * The erasure cascade, in full, because a partial one is theatre:
 *
 * 1. delete the user's `messages` rows;
 * 2. write the `opt_outs` row, so future messages are never stored;
 * 3. delete every `chunks` row whose `[first, last]` range **overlaps** a
 *    deleted message;
 * 4. replace `user_id` in `usage_events` with a **freshly generated random
 *    token** from `IdGenerator` — not a hash;
 * 5. delete the user's `pseudonyms` row, which makes any label already sitting
 *    in the error sink permanently unresolvable;
 * 6. delete the user's `user_prefs` row.
 *
 * The counts come back so the reply can state what happened, and so the test
 * can assert that step 3 actually ran.
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';

export interface ForgetUserCommand {
  readonly chatId: ChatId;
  readonly userId: UserId;
  /** Who asked. A member may only erase themselves (DESIGN §2). */
  readonly requestedBy: UserId;
  readonly at: Temporal.Instant;
}

export interface ForgetUserResult {
  readonly messagesDeleted: number;
  readonly chunksDeleted: number;
  readonly usageRowsAnonymised: number;
  readonly pseudonymDeleted: boolean;
  readonly optedOut: boolean;
}

export interface ForgetUser {
  execute(command: ForgetUserCommand): Promise<ForgetUserResult>;
}
