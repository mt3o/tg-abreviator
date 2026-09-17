/**
 * `ForgetUser` — `/forgetme` (DESIGN §2, §5, §11).
 *
 * The driving port (`ports/driving/forget-user.ts`) spells the cascade out in
 * six steps and this use case is exactly those six steps against the driven
 * stores — WS1 built each primitive (`deleteByUser`, `deleteCovering`,
 * `anonymiseUser`, …), nobody composed them.
 *
 * Two orderings here are load-bearing rather than incidental:
 *
 * - **The opt-out row is written before anything is deleted.** An update
 *   arriving mid-cascade must already be refused storage, or the poller would
 *   cheerfully re-insert a row a moment after it was erased.
 * - **`chunks` are deleted from the ids `messages` just gave back.** DESIGN §5:
 *   "deletes every chunk whose `[first,last]` range overlaps a deleted message
 *   … without the chunk invalidation, erasure is theatre." Asking the store for
 *   the ids first is what makes the overlap decidable at all.
 *
 * The `usage_events` step replaces the user id with a **freshly generated
 * random token** from `IdGenerator`, never a hash: Telegram user ids are a
 * small enumerable integer space, so a deterministic hash stays re-linkable and
 * is therefore not erasure (DESIGN §5).
 */
import { InvalidValueError } from '../../domain/errors.js';
import type { ChunkStore } from '../ports/driven/chunk-store.js';
import type { IdGenerator } from '../ports/driven/id-generator.js';
import type { MessageStore } from '../ports/driven/message-store.js';
import type { OptOutStore } from '../ports/driven/opt-out-store.js';
import type { PseudonymStore } from '../ports/driven/pseudonym-store.js';
import type { SettingsStore } from '../ports/driven/settings-store.js';
import type { UsageStore } from '../ports/driven/usage-store.js';
import type {
  ForgetUser,
  ForgetUserCommand,
  ForgetUserResult,
} from '../ports/driving/forget-user.js';

export interface ForgetUserDeps {
  readonly messages: MessageStore;
  readonly chunks: ChunkStore;
  readonly optOuts: OptOutStore;
  readonly usage: UsageStore;
  readonly settings: SettingsStore;
  readonly pseudonyms: PseudonymStore;
  readonly ids: IdGenerator;
}

export class ForgetUserUseCase implements ForgetUser {
  readonly #deps: ForgetUserDeps;

  constructor(deps: ForgetUserDeps) {
    this.#deps = deps;
  }

  async execute(command: ForgetUserCommand): Promise<ForgetUserResult> {
    const { chatId, userId, requestedBy } = command;
    if (requestedBy !== userId) {
      // DESIGN §2: "`/forgetme` — erase *own* rows". There is no argument that
      // could target anyone else, so a mismatch is a wiring bug, not a request.
      throw new InvalidValueError('/forgetme may only erase the caller');
    }
    const { messages, chunks, optOuts, usage, settings, pseudonyms, ids } = this.#deps;

    // Step 2 first, deliberately — see the module docstring.
    await optOuts.optOut(chatId, userId);

    const deletedMessageIds = await messages.deleteByUser(chatId, userId);
    const chunksDeleted = await chunks.deleteCovering(chatId, deletedMessageIds);
    const usageRowsAnonymised = await usage.anonymiseUser(chatId, userId, ids.token());

    const hadPseudonym = (await pseudonyms.peek(chatId, userId)) !== null;
    if (hadPseudonym) await pseudonyms.deleteUser(chatId, userId);

    await settings.deleteUser(chatId, userId);

    return {
      messagesDeleted: deletedMessageIds.length,
      chunksDeleted,
      usageRowsAnonymised,
      pseudonymDeleted: hadPseudonym,
      optedOut: true,
    };
  }
}
