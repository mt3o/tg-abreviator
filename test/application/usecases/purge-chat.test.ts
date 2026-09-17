/**
 * `/forget` — the chat-wide wipe (DESIGN §2, §5, §11).
 */
import { describe, expect, it } from 'vitest';

import { PurgeChatUseCase } from '../../../src/application/usecases/purge-chat.js';
import { asMessageId } from '../../../src/domain/model/ids.js';
import { Temporal } from '../../../src/domain/time/temporal.js';
import { createFakeStores } from '../../fakes/create-fake-stores.js';
import { FakeConfig } from '../../fakes/fake-config.js';
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
  const stores = createFakeStores();
  const config = new FakeConfig();
  const useCase = new PurgeChatUseCase({
    messages: stores.messages,
    chunks: stores.chunks,
    optOuts: stores.optOuts,
    usage: stores.usage,
    settings: stores.settings,
    pseudonyms: stores.pseudonyms,
    config,
  });
  return { ...stores, config, useCase };
}

async function seed(c: ReturnType<typeof makeCase>): Promise<void> {
  await c.messages.upsertMany(CHAT_A, [
    makeMessage({ messageId: 1, userId: USER_ALA }),
    makeMessage({ messageId: 2, userId: USER_OLA }),
  ]);
  await c.messages.upsert(CHAT_B, makeMessage({ chatId: CHAT_B, messageId: 1 }));
  await c.chunks.save(CHAT_A, makeChunk({ firstMsgId: 1, lastMsgId: 2 }));
  await c.usage.record(CHAT_A, makeUsageEvent());
  await c.settings.putChatSettings(CHAT_A, { tz: 'Europe/Warsaw' }, USER_ALA, AT);
  await c.settings.putUserPrefs(CHAT_A, USER_OLA, { dmDelivery: true });
  await c.optOuts.optOut(CHAT_A, USER_OLA);
  await c.pseudonyms.labelFor(CHAT_A, USER_ALA);
  await c.pseudonyms.labelForChat(CHAT_A);
}

describe('PurgeChatUseCase', () => {
  it('wipes every trace of the chat and leaves other chats alone', async () => {
    const c = makeCase();
    await seed(c);

    const result = await c.useCase.execute({ chatId: CHAT_A, requestedBy: USER_ALA, at: AT });

    expect(result).toEqual({ messagesDeleted: 2, chunksDeleted: 1, usageRowsDeleted: 1 });
    expect(c.messages.dump(CHAT_A)).toHaveLength(0);
    expect(c.usage.dump(CHAT_A)).toHaveLength(0);
    expect(
      await c.chunks.find(CHAT_A, {
        threadId: null,
        firstMsgId: asMessageId(1),
        lastMsgId: asMessageId(2),
        model: 'claude-haiku-4-5',
        promptVersion: 'v1',
      }),
    ).toBeNull();
    expect(await c.settings.getChatSettings(CHAT_A)).toBeNull();
    expect(await c.settings.getUserPrefs(CHAT_A, USER_OLA)).toBeNull();
    expect(await c.optOuts.isOptedOut(CHAT_A, USER_OLA)).toBe(false);
    // DESIGN §11: the chat's own label stops resolving too.
    expect(await c.pseudonyms.peek(CHAT_A, USER_ALA)).toBeNull();

    expect(c.messages.dump(CHAT_B)).toHaveLength(1);
  });

  it('invalidates the derived config, since the chat layer it came from is gone', async () => {
    const c = makeCase();
    await seed(c);
    c.config.setChatLayer(CHAT_A, { timezone: { default: 'America/New_York' } });
    const before = await c.config.forChat(CHAT_A);
    expect(before.get('timezone').default).toBe('America/New_York');
    const derivationsAfterFirstRead = c.config.derivations;

    await c.useCase.execute({ chatId: CHAT_A, requestedBy: USER_ALA, at: AT });

    // The cached derivation was dropped: the next read builds a fresh one.
    await c.config.forChat(CHAT_A);
    expect(c.config.derivations).toBe(derivationsAfterFirstRead + 1);
  });
});
