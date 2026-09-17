/**
 * `PseudonymStore` — `pseudonyms` (DESIGN §11).
 *
 * Errors need *some* identity or they are useless — you cannot tell whether one
 * user hit a bug forty times or forty users hit it once. So the bot emits a
 * readable pseudonym (`kind-otter`) rather than nothing and rather than a raw
 * id.
 *
 * **A mapping table, not an HMAC.** An HMAC is re-derivable: as long as the
 * secret exists, any user id maps back to its tag, so the pseudonym is
 * re-linkable forever and `/forgetme` cannot reach it. A table inverts that —
 * the linkage lives in SQLite, where the TTL and `/forgetme` already have
 * authority. Delete the row and the label in GlitchTip becomes permanently
 * unresolvable.
 *
 * `chatId` is the required first parameter of every method (DESIGN §6.1).
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { PseudonymLabel } from '../../../domain/model/pseudonym.js';

export interface PseudonymStore {
  /**
   * Allocates on first use from the word list, scoped per chat, and is stable
   * afterwards. Deterministic-on-insert: the same row always yields the same
   * label until it is deleted.
   */
  labelFor(chatId: ChatId, userId: UserId): Promise<PseudonymLabel>;

  /** The chat's own label (`chat=quiet-harbor`). Allocates on first use. */
  labelForChat(chatId: ChatId): Promise<PseudonymLabel>;

  /**
   * Reads without allocating. Used when reporting an error must not create new
   * personal data, and to prove that a deleted row is unresolvable.
   */
  peek(chatId: ChatId, userId: UserId): Promise<PseudonymLabel | null>;

  /**
   * `/forgetme` (DESIGN §5, §11). After this, any label already sitting in the
   * error sink is permanently unresolvable — the external events decay into
   * genuinely anonymous noise.
   */
  deleteUser(chatId: ChatId, userId: UserId): Promise<void>;

  /** `/forget`: the chat's own label and every user label in it. */
  deleteChat(chatId: ChatId): Promise<void>;

  /** TTL sweep: expired on the same schedule as messages (DESIGN §11). */
  deleteOlderThan(chatId: ChatId, cutoff: Temporal.Instant): Promise<number>;
}
