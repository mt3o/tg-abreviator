/**
 * `/forgetme`'s erasure cascade (DESIGN §5, §11).
 *
 * "Coarse, cheap, correct. Without the chunk invalidation, erasure is
 * theatre." Each assertion below is one step of that sentence.
 */
import { describe, expect, it } from 'vitest';

import { ForgetUserUseCase } from '../../../src/application/usecases/forget-user.js';
import { InvalidValueError } from '../../../src/domain/errors.js';
import { asMessageId, asUserId } from '../../../src/domain/model/ids.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { createFakeStores } from '../../fakes/create-fake-stores.js';
import { FakeIdGenerator } from '../../fakes/fake-id-generator.js';
import {
  CHAT_A,
  CHAT_B,
  USER_ALA,
  USER_OLA,
  makeChunk,
  makeMessage,
  makeUsageEvent,
} from '../../conformance/support.js';

const AT = Temporal.Instant.from('2026-09-17T12:00:00Z');

function makeCase() {
  const ids = new FakeIdGenerator(7);
  const stores = createFakeStores({ ids });
  const useCase = new ForgetUserUseCase({
    messages: stores.messages,
    chunks: stores.chunks,
    optOuts: stores.optOuts,
    usage: stores.usage,
    settings: stores.settings,
    pseudonyms: stores.pseudonyms,
    ids,
  });
  return { ...stores, ids, useCase };
}

describe('ForgetUserUseCase', () => {
  it('deletes the rows, opts out, invalidates covering chunks and anonymises usage', async () => {
    const c = makeCase();
    await c.messages.upsertMany(CHAT_A, [
      makeMessage({ messageId: 1, userId: USER_ALA, text: 'ala one' }),
      makeMessage({ messageId: 2, userId: USER_OLA, text: 'ola one' }),
      makeMessage({ messageId: 3, userId: USER_ALA, text: 'ala two' }),
    ]);
    // A chunk covering [1,3] overlaps a message that is about to be deleted.
    await c.chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 3 }));
    await c.usage.record(CHAT_A, makeUsageEvent());
    await c.settings.putUserPrefs(CHAT_A, USER_ALA, { dmDelivery: true });
    const label = await c.pseudonyms.labelFor(CHAT_A, USER_ALA);

    const result = await c.useCase.execute({
      chatId: CHAT_A,
      userId: USER_ALA,
      requestedBy: USER_ALA,
      at: AT,
    });

    expect(result.messagesDeleted).toBe(2);
    expect(result.chunksDeleted).toBe(1);
    expect(result.usageRowsAnonymised).toBe(1);
    expect(result.pseudonymDeleted).toBe(true);
    expect(result.optedOut).toBe(true);

    // The other user's message survives; nothing of Ala's does.
    const remaining = c.messages.dump(CHAT_A);
    expect(remaining.map((row) => row.messageId)).toEqual([asMessageId(2)]);

    // Future messages are never stored (DESIGN §5), not stored as a placeholder.
    expect(await c.optOuts.isOptedOut(CHAT_A, USER_ALA)).toBe(true);

    // DESIGN §5: a fresh random token, not a hash of the user id.
    const usageRow = c.usage.dump(CHAT_A)[0];
    expect(usageRow?.user.kind).toBe('anonymised');
    if (usageRow?.user.kind === 'anonymised') {
      expect(usageRow.user.token).not.toContain(String(USER_ALA));
      expect(c.ids.issued).toContain(usageRow.user.token);
    }

    // DESIGN §11: the label in the error sink becomes permanently unresolvable.
    expect(label).not.toBe('');
    expect(await c.pseudonyms.peek(CHAT_A, USER_ALA)).toBeNull();

    // The user's own preferences are their data too.
    expect(await c.settings.getUserPrefs(CHAT_A, USER_ALA)).toBeNull();
  });

  it('never reaches into another chat', async () => {
    const c = makeCase();
    await c.messages.upsert(CHAT_A, makeMessage({ messageId: 1, userId: USER_ALA }));
    await c.messages.upsert(CHAT_B, makeMessage({ chatId: CHAT_B, messageId: 1, userId: USER_ALA }));

    await c.useCase.execute({ chatId: CHAT_A, userId: USER_ALA, requestedBy: USER_ALA, at: AT });

    expect(c.messages.dump(CHAT_A)).toHaveLength(0);
    expect(c.messages.dump(CHAT_B)).toHaveLength(1);
    expect(await c.optOuts.isOptedOut(CHAT_B, USER_ALA)).toBe(false);
  });

  it('refuses to erase anyone but the caller', async () => {
    const c = makeCase();
    await expect(
      c.useCase.execute({
        chatId: CHAT_A,
        userId: USER_ALA,
        requestedBy: asUserId(999),
        at: AT,
      }),
    ).rejects.toBeInstanceOf(InvalidValueError);
  });

  it('opts the user out before deleting, so a racing update is already refused', async () => {
    const c = makeCase();
    const order: string[] = [];
    const optOut = c.optOuts.optOut.bind(c.optOuts);
    const deleteByUser = c.messages.deleteByUser.bind(c.messages);
    c.optOuts.optOut = async (chatId, userId) => {
      order.push('optOut');
      await optOut(chatId, userId);
    };
    c.messages.deleteByUser = async (chatId, userId) => {
      order.push('deleteByUser');
      return await deleteByUser(chatId, userId);
    };

    await c.useCase.execute({ chatId: CHAT_A, userId: USER_ALA, requestedBy: USER_ALA, at: AT });

    expect(order).toEqual(['optOut', 'deleteByUser']);
  });
});
