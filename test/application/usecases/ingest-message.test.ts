/**
 * `IngestMessage` (DESIGN §3, §4, §5, §6) — the only write path into the
 * corpus. Built entirely against Phase 0's fakes.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { IngestMessageUseCase } from '../../../src/application/usecases/ingest-message.js';
import type { IngestMessageCommandExt } from '../../../src/application/usecases/ingest-message.js';
import { asChatId, asUserId } from '../../../src/domain/model/ids.js';
import { CHAT_A, makeMessage } from '../../conformance/support.js';
import { FakeChatGateway } from '../../fakes/fake-chat-gateway.js';
import { FakeConfig, TEST_ENV_LAYER } from '../../fakes/fake-config.js';
import { FakeMessageStore } from '../../fakes/fake-message-store.js';
import { FakeOptOutStore } from '../../fakes/fake-opt-out-store.js';

const BOT_USER_ID = asUserId(999000001);

function makeUseCase() {
  const messages = new FakeMessageStore();
  const optOuts = new FakeOptOutStore();
  const gateway = new FakeChatGateway({ identity: { userId: BOT_USER_ID, username: 'test_bot' } });
  const config = new FakeConfig({
    file: { telegram: { allowlist: [CHAT_A] }, bot: { operatorContact: '@op' } },
    env: TEST_ENV_LAYER,
  });
  const useCase = new IngestMessageUseCase({ messages, optOuts, config, gateway });
  return { useCase, messages, optOuts, gateway, config };
}

describe('IngestMessageUseCase', () => {
  let ctx: ReturnType<typeof makeUseCase>;

  beforeEach(() => {
    ctx = makeUseCase();
  });

  it('stores a new message from an allowlisted chat', async () => {
    const message = makeMessage({ messageId: 1, text: 'hej' });
    const outcome = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });
    expect(outcome).toEqual({ kind: 'stored' });
    expect(ctx.messages.dump(CHAT_A)).toHaveLength(1);
    expect(ctx.messages.dump(CHAT_A)[0]?.text).toBe('hej');
  });

  it('updates an edited message in place rather than adding a row', async () => {
    const original = makeMessage({ messageId: 1, text: 'hej' });
    await ctx.useCase.execute({ message: original, isEdit: false, botUserId: BOT_USER_ID });

    const edited = makeMessage({ messageId: 1, text: 'hej (poprawione)' });
    const outcome = await ctx.useCase.execute({ message: edited, isEdit: true, botUserId: BOT_USER_ID });

    expect(outcome).toEqual({ kind: 'updated' });
    const rows = ctx.messages.dump(CHAT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('hej (poprawione)');
  });

  it('is idempotent under a replayed (non-edit) update', async () => {
    const message = makeMessage({ messageId: 1, text: 'hej' });
    const first = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });
    const replay = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });

    expect(first).toEqual({ kind: 'stored' });
    expect(replay).toEqual({ kind: 'stored' });
    expect(ctx.messages.dump(CHAT_A)).toHaveLength(1);
  });

  it('replies "not authorised", leaves the chat, and stores nothing for a chat off the allowlist', async () => {
    // CHAT_A is the only allowlisted chat in this fixture; anything else must
    // be refused (DESIGN §5).
    const otherChat = asChatId(-42);
    const outcome = await ctx.useCase.execute({
      message: makeMessage({ chatId: otherChat, messageId: 1 }),
      isEdit: false,
      botUserId: BOT_USER_ID,
    });

    expect(outcome).toEqual({ kind: 'left_chat' });
    expect(ctx.messages.dump(otherChat)).toHaveLength(0);
    expect(ctx.gateway.leftChats).toContain(otherChat);
    expect(ctx.gateway.textsFor(otherChat)).toHaveLength(1);
  });

  it('skips the bot\'s own messages without storing them', async () => {
    const own = makeMessage({ messageId: 1, userId: BOT_USER_ID, text: 'podsumowanie...' });
    const outcome = await ctx.useCase.execute({ message: own, isEdit: false, botUserId: BOT_USER_ID });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'own_message' });
    expect(ctx.messages.dump(CHAT_A)).toHaveLength(0);
  });

  it('skips a different bot\'s messages when the adapter flags the sender as another bot', async () => {
    const otherBotUser = asUserId(777001);
    const message = makeMessage({ messageId: 1, userId: otherBotUser, text: 'weather update' });
    const command: IngestMessageCommandExt = {
      message,
      isEdit: false,
      botUserId: BOT_USER_ID,
      senderIsOtherBot: true,
    };
    const outcome = await ctx.useCase.execute(command);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'other_bot' });
    expect(ctx.messages.dump(CHAT_A)).toHaveLength(0);
  });

  it('stores nothing at all for an opted-out user — not even a placeholder', async () => {
    const user = asUserId(55);
    await ctx.optOuts.optOut(CHAT_A, user);
    const message = makeMessage({ messageId: 1, userId: user, text: 'sekret' });
    const outcome = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'opted_out' });
    expect(ctx.messages.dump(CHAT_A)).toHaveLength(0);
  });

  it('skips an empty text message as no_content', async () => {
    const message = makeMessage({ messageId: 1, kind: 'text', text: '   ' });
    const outcome = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_content' });
  });

  it('stores non-text kinds even with null text (the kind itself is the content)', async () => {
    const message = makeMessage({ messageId: 1, kind: 'sticker', text: null });
    const outcome = await ctx.useCase.execute({ message, isEdit: false, botUserId: BOT_USER_ID });
    expect(outcome).toEqual({ kind: 'stored' });
  });
});
