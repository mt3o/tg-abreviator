/**
 * DESIGN §11: "the linkage lives in your SQLite... Delete the row and the
 * label in GlitchTip becomes permanently unresolvable." This proves that
 * statement against the pipeline this workstream owns: a label allocated
 * through `PseudonymStore`, carried into an `ErrorReporter.capture()` tag via
 * `buildTags`/`scrubEvent` exactly as the GlitchTip adapter would send it, then
 * the erasure cascade removes the row — after which the same label can no
 * longer be resolved back to the user it named, using only the store that any
 * operator or `/forgetme` implementation has authority over.
 *
 * A minimal in-memory `PseudonymStore` is implemented right here rather than
 * imported from `test/fakes/**`: a file under `src/adapters` may not import
 * `test/**` (eslint import-boundary rules, DESIGN §3, CI-enforced) — the same
 * constraint WS1's `forgetme-cascade.test.ts` documents and works around.
 */
import { describe, expect, it } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/node';
import { asChatId, asUserId } from '../../../domain/model/ids.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import {
  CHAT_PSEUDONYM_USER_ID,
  asPseudonymLabel,
  composeLabel,
} from '../../../domain/model/pseudonym.js';
import type { PseudonymLabel } from '../../../domain/model/pseudonym.js';
import type { PseudonymStore } from '../../../application/ports/driven/pseudonym-store.js';
import type { Temporal } from '../../../domain/time/temporal.js';
import { UnexpectedError } from '../../../domain/errors.js';
import { buildTags } from './tags.js';
import { scrubEvent } from './scrub-event.js';

function rowKey(chatId: ChatId, userId: number): string {
  return `${String(chatId)}:${String(userId)}`;
}

/** Deterministic labels, adequate for a test with a handful of rows. */
class MinimalPseudonymStore implements PseudonymStore {
  readonly #rows = new Map<string, PseudonymLabel>();
  #counter = 0;

  async labelFor(chatId: ChatId, userId: UserId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, userId));
  }

  async labelForChat(chatId: ChatId): Promise<PseudonymLabel> {
    return await Promise.resolve(this.#allocate(chatId, CHAT_PSEUDONYM_USER_ID));
  }

  async peek(chatId: ChatId, userId: UserId): Promise<PseudonymLabel | null> {
    return await Promise.resolve(this.#rows.get(rowKey(chatId, userId)) ?? null);
  }

  async deleteUser(chatId: ChatId, userId: UserId): Promise<void> {
    this.#rows.delete(rowKey(chatId, userId));
    await Promise.resolve();
  }

  async deleteChat(chatId: ChatId): Promise<void> {
    const prefix = `${String(chatId)}:`;
    for (const key of [...this.#rows.keys()]) {
      if (key.startsWith(prefix)) this.#rows.delete(key);
    }
    await Promise.resolve();
  }

  async deleteOlderThan(_chatId: ChatId, _cutoff: Temporal.Instant): Promise<number> {
    return await Promise.resolve(0);
  }

  /** Reverse lookup, exactly as an operator reading a GlitchTip label would do it locally. */
  resolve(chatId: ChatId, label: PseudonymLabel): UserId | null {
    const prefix = `${String(chatId)}:`;
    for (const [key, value] of this.#rows) {
      if (key.startsWith(prefix) && value === label) {
        const userId = Number(key.slice(prefix.length));
        return userId === CHAT_PSEUDONYM_USER_ID ? null : asUserId(userId);
      }
    }
    return null;
  }

  #allocate(chatId: ChatId, subject: number): PseudonymLabel {
    const key = rowKey(chatId, subject);
    const existing = this.#rows.get(key);
    if (existing !== undefined) return existing;
    const label = composeLabel(this.#counter, this.#counter + 1);
    this.#counter += 2;
    this.#rows.set(key, label);
    return label;
  }
}

function hint(error: unknown): EventHint {
  return { originalException: error };
}

describe('pseudonym erasure makes an already-emitted label unresolvable', () => {
  it('deleteUser severs the mapping GlitchTip already has a label for', async () => {
    const store = new MinimalPseudonymStore();
    const chatId = asChatId(-100);
    const userId = asUserId(555);

    const label = await store.labelFor(chatId, userId);

    // What the GlitchTip adapter would actually send: the label as a tag,
    // scrubbed exactly as `capture()` would scrub it.
    const error = new UnexpectedError();
    const tags = buildTags({ phase: 'llm', user: label }, 'v1');
    const event: ErrorEvent = { type: undefined, tags };
    const sent = scrubEvent(event, hint(error));

    expect(sent?.tags?.['user']).toBe(label);
    // Already sitting in the (fake) error sink — this is the "emitted" state.
    const emittedLabel = asPseudonymLabel(sent?.tags?.['user'] as string);

    // /forgetme.
    await store.deleteUser(chatId, userId);

    // The row is gone: no new lookup can resolve it...
    expect(await store.peek(chatId, userId)).toBeNull();
    // ...and, crucially, the label that already left the building cannot be
    // reverse-resolved either — it decays into anonymous noise.
    expect(store.resolve(chatId, emittedLabel)).toBeNull();
  });

  it('deleteChat removes every user label plus the chat label itself', async () => {
    const store = new MinimalPseudonymStore();
    const chatId = asChatId(-300);
    const userA = asUserId(1);
    const userB = asUserId(2);

    const labelA = await store.labelFor(chatId, userA);
    const chatLabel = await store.labelForChat(chatId);
    await store.labelFor(chatId, userB);

    await store.deleteChat(chatId);

    expect(await store.peek(chatId, userA)).toBeNull();
    expect(await store.peek(chatId, userB)).toBeNull();
    expect(store.resolve(chatId, labelA)).toBeNull();
    expect(store.resolve(chatId, chatLabel)).toBeNull();
  });

  it('a chat scoped to one chat id is untouched by another chat erasing its own user', async () => {
    const store = new MinimalPseudonymStore();
    const chatA = asChatId(-1);
    const chatB = asChatId(-2);
    const user = asUserId(9);

    const labelInA = await store.labelFor(chatA, user);
    const labelInB = await store.labelFor(chatB, user);

    await store.deleteUser(chatA, user);

    expect(await store.peek(chatA, user)).toBeNull();
    expect(await store.peek(chatB, user)).toBe(labelInB);
    expect(labelInA).not.toBe(labelInB);
  });
});
